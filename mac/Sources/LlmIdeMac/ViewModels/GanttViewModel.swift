// View model for the single, provider-neutral Gantt (GanttContainerView →
// GanttView). It speaks `RepoBackend` / `RepoIssue`, so GitLab and GitHub
// render through the exact same chart.
//
// Date sourcing differs per provider and is normalised here so the view never
// branches on the backend:
//   • GitLab — native per-issue `dueDate` + milestone start/due.
//   • GitHub — no native per-issue dates, so our /kb/issue-schedule overlay
//     supplies start / due / estimate / dependsOn. The adapter also folds the
//     milestone's due date into `RepoIssue.dueDate`, so an unscheduled GitHub
//     issue in a milestone still lands on the chart.

import Foundation
import SwiftUI

@MainActor
final class GanttViewModel: ObservableObject {
    @Published var issues: [RepoIssue] = []
    @Published var milestones: [RepoMilestone] = []
    @Published var members: [RepoUser] = []
    /// Scheduling overlay keyed by issue number. Populated only for backends
    /// with `usesScheduleOverlay` (GitHub); empty elsewhere.
    @Published var schedules: [Int: LlmIdeAPIClient.IssueSchedule] = [:]

    @Published var isLoading = false
    @Published var errorMessage: String?

    // Filters
    @Published var stateFilter: String = "all"
    @Published var selectedMilestoneIds: Set<String> = []
    @Published var selectedAssigneeIds: Set<String> = []
    @Published var selectedLabels: Set<String> = []
    @Published var rangeStart: Date?
    @Published var rangeEnd: Date?
    // Default false so the Gantt's issue count matches the Issues
    // board out of the box. Most projects have undated issues —
    // hiding them by default made the chart look empty even when the
    // board clearly showed open issues. User can still toggle.
    @Published var hideBlankRows: Bool = false
    @Published var searchText: String = ""
    @Published var visibleCategories: Set<String> = ["open", "closed", "overdue"]

    /// Max issue pages drained per project. Guards against a backend that
    /// clamps an out-of-range page instead of returning an empty list.
    private let maxIssuePages = 20

    // ISO8601 calendar — avoids DST off-by-one in day math.
    // Stored once; Calendar construction is not cheap and this is
    // read on every GanttView body evaluation.
    let layoutCalendar: Calendar = {
        var c = Calendar(identifier: .iso8601)
        c.timeZone = .current
        return c
    }()

    // MARK: - Date parsing

    func parseDate(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return AppDateFormatter.parseISO(s) ?? AppDateFormatter.parseDateOnly(s)
    }

    // MARK: - Load

    /// Load everything the chart needs for one project through the neutral
    /// backend protocol. `api` is only used for the scheduling overlay and may
    /// be nil — the chart then falls back to whatever native dates exist.
    func load(client: RepoBackend, project: RepoProject, api: LlmIdeAPIClient?) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            async let milestonesTask = client.listMilestones(projectId: project.id)
            // Members feed the assignee filter only — a token without the
            // members/collaborators scope must not blank the whole chart.
            async let membersTask: [RepoUser] = (try? await client.listMembers(projectId: project.id)) ?? []
            async let firstPageTask = client.listIssues(
                projectId: project.id, filter: RepoIssueFilter(state: .all), page: 1)

            let (ms, mem, firstPage) = try await (milestonesTask, membersTask, firstPageTask)
            self.milestones = ms
            self.members    = mem
            self.issues     = try await drainIssues(client: client, projectId: project.id,
                                                    firstPage: firstPage)

            if client.usesScheduleOverlay, let api {
                // Best-effort: an unreachable local server must not break the
                // chart, it just loses the start/estimate/dependency detail.
                self.schedules = (try? await api.listIssueSchedules(
                    provider: client.kind.rawValue, repo: project.fullName)) ?? [:]
            } else {
                self.schedules = [:]
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Continue paging issues from page 2 onward, reusing the already-fetched
    /// first page. Dedups by id so a backend that repeats content terminates.
    private func drainIssues(client: RepoBackend, projectId: String,
                             firstPage: [RepoIssue]) async throws -> [RepoIssue] {
        var all: [RepoIssue] = []
        var seen = Set<String>()
        all.append(contentsOf: firstPage.filter { seen.insert($0.id).inserted })
        if firstPage.isEmpty { return all }
        for page in 2...maxIssuePages {
            let batch = try await client.listIssues(
                projectId: projectId, filter: RepoIssueFilter(state: .all), page: page)
            let fresh = batch.filter { seen.insert($0.id).inserted }
            if fresh.isEmpty { break }
            all.append(contentsOf: fresh)
        }
        return all
    }

    // MARK: - Schedule overlay

    /// The overlay row for an issue, but only when it actually places the issue
    /// on the timeline (a row with neither a start nor a due carries only an
    /// estimate/dependency note and must not win over native dates).
    func schedule(for issue: RepoIssue) -> LlmIdeAPIClient.IssueSchedule? {
        guard let s = schedules[issue.number],
              s.startDate != nil || s.dueDate != nil else { return nil }
        return s
    }

    /// Estimate/dependency annotation for the row's meta line, if any.
    func scheduleNote(for issue: RepoIssue) -> String? {
        guard let s = schedules[issue.number] else { return nil }
        var parts: [String] = []
        if let est = s.estimateDays, est > 0 {
            let n = est.truncatingRemainder(dividingBy: 1) == 0
                ? String(Int(est)) : String(format: "%.1f", est)
            parts.append("\(n)d")
        }
        if !s.dependsOn.isEmpty {
            parts.append("blocks on #\(s.dependsOn.map(String.init).joined(separator: ", #"))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Finish-to-start dependency pairs among visible issues: blocker issue
    /// number → dependent issue number. Skips deps on issues not in the list
    /// (filtered out or missing from the project).
    func dependencyEdges(in visibleIssues: [RepoIssue]) -> [(blocker: Int, dependent: Int)] {
        let visible = Set(visibleIssues.map(\.number))
        var out: [(Int, Int)] = []
        for issue in visibleIssues {
            guard let deps = schedules[issue.number]?.dependsOn, !deps.isEmpty else { continue }
            for blocker in deps where visible.contains(blocker) {
                out.append((blocker, issue.number))
            }
        }
        return out
    }

    // MARK: - Date helpers

    /// Default bar length when only one end of a schedule is known.
    private let defaultSpanDays: Double = 7

    func startDate(for issue: RepoIssue) -> Date {
        if let s = schedule(for: issue) {
            if let start = parseDate(s.startDate) { return start }
            if let due = parseDate(s.dueDate) {
                return due.addingTimeInterval(-(s.estimateDays ?? defaultSpanDays) * 86_400)
            }
        }
        if let ms = issue.milestone, let sd = parseDate(ms.startDate) { return sd }
        // A native due date with no other anchor still deserves a real bar:
        // look back a week, matching the overlay's single-ended fallback.
        if let due = parseDate(issue.dueDate) {
            let created = parseDate(issue.createdAt)
            let lookback = due.addingTimeInterval(-defaultSpanDays * 86_400)
            // Never start a bar before the issue existed.
            if let created, created > lookback, created < due { return created }
            return lookback
        }
        return parseDate(issue.createdAt) ?? Date()
    }

    func endDate(for issue: RepoIssue) -> Date? {
        if let s = schedule(for: issue) {
            if let due = parseDate(s.dueDate) { return due }
            if let start = parseDate(s.startDate) {
                return start.addingTimeInterval((s.estimateDays ?? defaultSpanDays) * 86_400)
            }
        }
        if let d = parseDate(issue.dueDate) { return d }
        if let ms = issue.milestone, let dd = parseDate(ms.dueDate) { return dd }
        return nil
    }

    func hasUsefulDates(_ issue: RepoIssue) -> Bool {
        if schedule(for: issue) != nil { return true }
        if issue.dueDate != nil { return true }
        if let ms = issue.milestone,
           ms.startDate != nil || ms.dueDate != nil { return true }
        return false
    }

    // MARK: - Category

    func category(of issue: RepoIssue) -> String {
        if issue.state == "closed" { return "closed" }
        if let due = endDate(for: issue), due < Date() { return "overdue" }
        return "open"
    }

    func toggleCategory(_ key: String) {
        if visibleCategories.contains(key) {
            if visibleCategories.count > 1 { visibleCategories.remove(key) }
        } else {
            visibleCategories.insert(key)
        }
    }

    // MARK: - Filtering

    /// Everything except the category (open/closed/overdue) legend toggles —
    /// so the legend can show accurate counts for the categories it hides.
    private func passesBaseFilters(_ issue: RepoIssue) -> Bool {
        if hideBlankRows && !hasUsefulDates(issue) { return false }
        if stateFilter != "all" && issue.state != stateFilter { return false }
        if !selectedMilestoneIds.isEmpty {
            guard let mid = issue.milestone?.id, selectedMilestoneIds.contains(mid) else { return false }
        }
        if !selectedAssigneeIds.isEmpty {
            let aids = Set(issue.assignees.map { $0.id })
            if aids.isDisjoint(with: selectedAssigneeIds) { return false }
        }
        if !selectedLabels.isEmpty {
            let issueLabels = Set(issue.labels)
            if issueLabels.isDisjoint(with: selectedLabels) { return false }
        }
        if !searchText.isEmpty {
            let q = searchText.lowercased()
            let hay = "\(issue.number) \(issue.title) \(issue.labels.joined(separator: " "))".lowercased()
            if !hay.contains(q) { return false }
        }
        let s = startDate(for: issue)
        let e = endDate(for: issue) ?? s
        if let rs = rangeStart, e < rs { return false }
        if let re = rangeEnd,   s > re { return false }
        return true
    }

    var filteredIssues: [RepoIssue] {
        issues.filter { passesBaseFilters($0) && visibleCategories.contains(category(of: $0)) }
    }

    var counts: (open: Int, closed: Int, overdue: Int) {
        var o = 0, c = 0, ov = 0
        for i in issues where passesBaseFilters(i) {
            switch category(of: i) {
            case "open":    o += 1
            case "closed":  c += 1
            case "overdue": ov += 1
            default: break
            }
        }
        return (o, c, ov)
    }

    // MARK: - Active filter data

    var activeAssignees: [RepoUser] {
        var seen: Set<String> = []
        var out: [RepoUser] = []
        for issue in issues {
            for a in issue.assignees where !seen.contains(a.id) {
                seen.insert(a.id)
                out.append(a)
            }
        }
        return out.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    var activeMilestones: [RepoMilestone] {
        var seen: Set<String> = []
        var out: [RepoMilestone] = []
        for issue in issues {
            if let m = issue.milestone, !seen.contains(m.id) {
                seen.insert(m.id)
                out.append(m)
            }
        }
        return out.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    var activeLabels: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for issue in issues {
            for lbl in issue.labels where !seen.contains(lbl) {
                seen.insert(lbl)
                out.append(lbl)
            }
        }
        return out.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    // MARK: - Timeline bounds

    // MARK: - Day-header metadata cache
    //
    // Header rows (dayNumberRow, weekdayRow, weekend tinting in drawChart)
    // need per-day Calendar calls — `cal.dayOffset`, `cal.component(.weekday)`,
    // `cal.isDateInToday`.  For a ~365-day window each redraw runs 1k+ of
    // those, and SwiftUI redraws the band on every scroll/zoom/filter tick.
    // We memoize the per-day metadata against a (start, days) key and reuse
    // it as long as those don't change.

    struct DayMeta {
        let date: Date
        let weekday: Int        // cal.component(.weekday, …)
        let isWeekend: Bool
        let isToday: Bool
        let dayLabel: String
        let weekdayLabel: String
    }

    private var dayMetaCacheKey: (startUTC: TimeInterval, days: Int, todayUTC: TimeInterval)?
    private var dayMetaCache: [DayMeta] = []

    func dayMeta(start: Date, days: Int) -> [DayMeta] {
        let cal = layoutCalendar
        // Today changes only at midnight — fold it into the cache key so a
        // long-lived session still gets a fresh "isToday" flag after the
        // day rolls over.
        let todayKey = cal.startOfDay(for: Date()).timeIntervalSince1970
        let startKey = cal.startOfDay(for: start).timeIntervalSince1970
        let key = (startKey, days, todayKey)
        if let cur = dayMetaCacheKey,
           cur.startUTC == key.0 && cur.days == key.1 && cur.todayUTC == key.2 {
            return dayMetaCache
        }
        var out: [DayMeta] = []
        out.reserveCapacity(days)
        for i in 0..<days {
            let date = cal.date(byAdding: .day, value: i, to: start) ?? start
            let weekday = cal.component(.weekday, from: date)
            out.append(DayMeta(
                date: date,
                weekday: weekday,
                isWeekend: weekday == 1 || weekday == 7,
                isToday: cal.isDateInToday(date),
                dayLabel: AppDateFormatter.dayOfMonth(date),
                weekdayLabel: AppDateFormatter.weekdayAbbrev(date)
            ))
        }
        dayMetaCacheKey = key
        dayMetaCache = out
        return out
    }

    var timelineBounds: (Date, Date) {
        let cal = layoutCalendar
        let now = Date()
        let visible = filteredIssues
        guard !visible.isEmpty else {
            return (cal.date(byAdding: .day, value: -14, to: now) ?? now,
                    cal.date(byAdding: .day, value: 30, to: now) ?? now)
        }
        let starts = visible.map { startDate(for: $0) }
        let ends   = visible.map { endDate(for: $0) ?? startDate(for: $0) }
        let minD = starts.min() ?? now
        let maxD = ends.max() ?? now
        return (cal.date(byAdding: .day, value: -2, to: minD) ?? minD,
                cal.date(byAdding: .day, value: 2, to: maxD) ?? maxD)
    }
}

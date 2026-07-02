import Foundation
import SwiftUI

@MainActor
final class GanttViewModel: ObservableObject {
    @Published var issues: [RepoIssue] = []
    @Published var milestones: [RepoMilestone] = []
    @Published var members: [RepoUser] = []

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
    // board out of the box. Most GitLab projects have undated issues —
    // hiding them by default made the chart look empty even when the
    // board clearly showed open issues. User can still toggle.
    @Published var hideBlankRows: Bool = false
    @Published var searchText: String = ""
    @Published var visibleCategories: Set<String> = ["open", "closed", "overdue"]

    // ISO8601 calendar — avoids DST off-by-one in day math.
    // Stored once; Calendar construction is not cheap and this is
    // read on every GanttView body evaluation.
    let layoutCalendar: Calendar = {
        var c = Calendar(identifier: .iso8601)
        c.timeZone = .current
        return c
    }()

    /// Overlay schedules by issue number (GitHub). Empty for GitLab (native dates).
    private(set) var schedules: [Int: LlmIdeAPIClient.IssueSchedule] = [:]

    /// Test/`load` seam: set the issue set + overlay in one place so date logic
    /// is unit-testable without a live backend.
    func applyIssues(_ issues: [RepoIssue], schedules: [Int: LlmIdeAPIClient.IssueSchedule]) {
        self.schedules = schedules
        self.issues = issues
    }

    // MARK: - Date parsing

    func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        return AppDateFormatter.parseISO(s) ?? AppDateFormatter.parseDateOnly(s)
    }

    private static let sevenDays: TimeInterval = 7 * 86_400

    private func ymd(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    /// (start, end) for an issue, or nil when it has no usable dates.
    private func span(for issue: RepoIssue) -> (Date, Date)? {
        if let sched = schedules[issue.number], sched.startDate != nil || sched.dueDate != nil {
            let width = (sched.estimateDays ?? 7) * 86_400
            let s0 = ymd(sched.startDate), d0 = ymd(sched.dueDate)
            let s = s0 ?? d0!.addingTimeInterval(-width)
            let e = d0 ?? s0!.addingTimeInterval(width)
            return (s, e)
        }
        // Native (GitLab): due from issue.dueDate or milestone.dueDate.
        if let due = ymd(issue.dueDate) ?? ymd(issue.milestone?.dueDate) {
            let s = ymd(issue.milestone?.startDate) ?? due.addingTimeInterval(-Self.sevenDays)
            return (s, due)
        }
        return nil
    }

    // MARK: - Load

    func load(backend: RepoBackend, project: RepoProject, api: LlmIdeAPIClient?) async {
        isLoading = true; errorMessage = nil
        defer { isLoading = false }
        do {
            var all: [RepoIssue] = []; var seen = Set<String>()
            for page in 1...20 {
                // `.all` so the Gantt has both open + closed issues; the VM's own
                // stateFilter does the client-side narrowing (default "all").
                let batch = try await backend.listIssues(
                    projectId: project.id, filter: RepoIssueFilter(state: .all), page: page)
                let fresh = batch.filter { seen.insert($0.id).inserted }
                if fresh.isEmpty { break }
                all.append(contentsOf: fresh)
            }
            let ms = (try? await backend.listMilestones(projectId: project.id)) ?? []
            let mem = (try? await backend.listMembers(projectId: project.id)) ?? []
            var sched: [Int: LlmIdeAPIClient.IssueSchedule] = [:]
            if backend.usesScheduleOverlay, let api {
                sched = (try? await api.listIssueSchedules(provider: "github", repo: project.fullName)) ?? [:]
            }
            self.milestones = ms; self.members = mem
            applyIssues(all, schedules: sched)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Date helpers

    func hasUsefulDates(_ issue: RepoIssue) -> Bool { span(for: issue) != nil }

    func startDate(for issue: RepoIssue) -> Date {
        span(for: issue)?.0 ?? ymd(issue.createdAt) ?? Date(timeIntervalSince1970: 0)
    }

    func endDate(for issue: RepoIssue) -> Date? { span(for: issue)?.1 }

    // MARK: - Category

    func category(of issue: RepoIssue) -> String {
        if issue.state == "closed" { return "closed" }
        if let due = parseDate(issue.dueDate), due < Date() { return "overdue" }
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

    var filteredIssues: [RepoIssue] {
        issues.filter { issue in
            if hideBlankRows && !hasUsefulDates(issue) { return false }
            if !visibleCategories.contains(category(of: issue)) { return false }
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
    }

    // Pre-category filtered — for counting visible categories accurately
    private var preCategoryFiltered: [RepoIssue] {
        issues.filter { issue in
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
    }

    var counts: (open: Int, closed: Int, overdue: Int) {
        var o = 0, c = 0, ov = 0
        for i in preCategoryFiltered {
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
        guard !filteredIssues.isEmpty else {
            return (cal.date(byAdding: .day, value: -14, to: now) ?? now,
                    cal.date(byAdding: .day, value: 30, to: now) ?? now)
        }
        let starts = filteredIssues.map { startDate(for: $0) }
        let ends   = filteredIssues.map { endDate(for: $0) ?? startDate(for: $0) }
        let minD = starts.min() ?? now
        let maxD = ends.max() ?? now
        return (cal.date(byAdding: .day, value: -2, to: minD) ?? minD,
                cal.date(byAdding: .day, value: 2, to: maxD) ?? maxD)
    }
}

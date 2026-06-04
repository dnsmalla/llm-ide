import Foundation
import SwiftUI

@MainActor
final class GanttViewModel: ObservableObject {
    @Published var issues: [GitLabIssue] = []
    @Published var milestones: [GitLabMilestone] = []
    @Published var members: [GitLabUser] = []

    @Published var isLoading = false
    @Published var errorMessage: String?

    // Filters
    @Published var stateFilter: String = "all"
    @Published var selectedMilestoneIds: Set<Int> = []
    @Published var selectedAssigneeIds: Set<Int> = []
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

    // MARK: - Date parsing

    func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        return AppDateFormatter.parseISO(s) ?? AppDateFormatter.parseDateOnly(s)
    }

    // MARK: - Load

    func load(gitlab: GitLabClient, projectId: Int) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            async let issuesTask     = gitlab.fetchAllIssues(projectId: projectId)
            async let milestonesTask = gitlab.listMilestones(projectId: projectId)
            async let membersTask    = gitlab.listMembers(projectId: projectId)
            let (i, m, mem) = try await (issuesTask, milestonesTask, membersTask)
            self.issues     = i
            self.milestones = m
            self.members    = mem
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Date helpers

    func startDate(for issue: GitLabIssue) -> Date {
        if let ms = issue.milestone, let sd = parseDate(ms.startDate) { return sd }
        return parseDate(issue.createdAt) ?? Date()
    }

    func endDate(for issue: GitLabIssue) -> Date? {
        if let d = parseDate(issue.dueDate) { return d }
        if let ms = issue.milestone, let dd = parseDate(ms.dueDate) { return dd }
        return nil
    }

    func hasUsefulDates(_ issue: GitLabIssue) -> Bool {
        if issue.dueDate != nil { return true }
        if let ms = issue.milestone,
           ms.startDate != nil || ms.dueDate != nil { return true }
        return false
    }

    // MARK: - Category

    func category(of issue: GitLabIssue) -> String {
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

    var filteredIssues: [GitLabIssue] {
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
                let hay = "\(issue.iid) \(issue.title) \(issue.labels.joined(separator: " "))".lowercased()
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
    private var preCategoryFiltered: [GitLabIssue] {
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
                let hay = "\(issue.iid) \(issue.title) \(issue.labels.joined(separator: " "))".lowercased()
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

    var activeAssignees: [GitLabUser] {
        var seen: Set<Int> = []
        var out: [GitLabUser] = []
        for issue in issues {
            for a in issue.assignees where !seen.contains(a.id) {
                seen.insert(a.id)
                out.append(a)
            }
        }
        return out.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var activeMilestones: [GitLabMilestone] {
        var seen: Set<Int> = []
        var out: [GitLabMilestone] = []
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

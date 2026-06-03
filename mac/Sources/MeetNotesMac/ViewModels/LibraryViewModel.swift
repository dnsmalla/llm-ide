import Foundation
import Observation

@MainActor
@Observable
final class LibraryViewModel {
    enum DateGroup: String, Hashable, CaseIterable {
        case today      = "Today"
        case yesterday  = "Yesterday"
        case thisWeek   = "This Week"
        case thisMonth  = "This Month"
        case earlier    = "Earlier"
    }

    private let index: MeetingIndex
    var allRows: [MeetingIndex.Row] = []
    var filter: String = ""

    init(index: MeetingIndex) { self.index = index }

    func refresh() throws {
        allRows = try index.list()
    }

    var visibleRows: [MeetingIndex.Row] {
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return allRows }
        return allRows.filter {
            ($0.title ?? "").lowercased().contains(q)
            || ($0.gist ?? "").lowercased().contains(q)
        }
    }

    /// Rows grouped by recency bucket, ordered newest-first within each group.
    var groupedRows: [(group: DateGroup, rows: [MeetingIndex.Row])] {
        let cal = Calendar.current
        let now = Date()

        var buckets: [DateGroup: [MeetingIndex.Row]] = [:]
        for row in visibleRows {
            let date = Date(timeIntervalSince1970: TimeInterval(row.startedAt) / 1000)
            let group = dateGroup(for: date, calendar: cal, now: now)
            buckets[group, default: []].append(row)
        }

        return DateGroup.allCases.compactMap { g in
            guard let rows = buckets[g], !rows.isEmpty else { return nil }
            return (g, rows)
        }
    }

    private func dateGroup(for date: Date, calendar: Calendar, now: Date) -> DateGroup {
        if calendar.isDateInToday(date)     { return .today }
        if calendar.isDateInYesterday(date) { return .yesterday }
        let weekAgo = calendar.date(byAdding: .day, value: -7, to: now) ?? now
        if date > weekAgo                   { return .thisWeek }
        let monthAgo = calendar.date(byAdding: .month, value: -1, to: now) ?? now
        if date > monthAgo                  { return .thisMonth }
        return .earlier
    }
}

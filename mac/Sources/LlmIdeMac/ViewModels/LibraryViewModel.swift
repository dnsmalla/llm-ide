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
    private let calendar = Calendar.current

    // visibleRows/groupedRows are cached stored properties, recomputed only when
    // allRows or filter changes — they used to be computed properties that
    // re-filtered + re-bucketed (with Calendar date math) on every view render.
    var allRows: [MeetingIndex.Row] = [] { didSet { recompute() } }
    var filter: String = "" { didSet { recompute() } }

    private(set) var visibleRows: [MeetingIndex.Row] = []
    private(set) var groupedRows: [(group: DateGroup, rows: [MeetingIndex.Row])] = []

    init(index: MeetingIndex) { self.index = index }

    func refresh() throws {
        allRows = try index.list()   // didSet → recompute()
    }

    private func recompute() {
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let rows = q.isEmpty ? allRows : allRows.filter {
            ($0.title ?? "").lowercased().contains(q)
            || ($0.gist ?? "").lowercased().contains(q)
        }
        visibleRows = rows

        let now = Date()
        var buckets: [DateGroup: [MeetingIndex.Row]] = [:]
        for row in rows {
            let date = Date(timeIntervalSince1970: TimeInterval(row.startedAt) / 1000)
            buckets[dateGroup(for: date, now: now), default: []].append(row)
        }
        groupedRows = DateGroup.allCases.compactMap { g in
            guard let r = buckets[g], !r.isEmpty else { return nil }
            return (g, r)
        }
    }

    private func dateGroup(for date: Date, now: Date) -> DateGroup {
        let calendar = self.calendar
        if calendar.isDateInToday(date)     { return .today }
        if calendar.isDateInYesterday(date) { return .yesterday }
        let weekAgo = calendar.date(byAdding: .day, value: -7, to: now) ?? now
        if date > weekAgo                   { return .thisWeek }
        let monthAgo = calendar.date(byAdding: .month, value: -1, to: now) ?? now
        if date > monthAgo                  { return .thisMonth }
        return .earlier
    }
}

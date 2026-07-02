import Foundation
import RepoKit

/// Client-side sort for the issue list. The list pages every issue into memory,
/// so sorting in-memory is uniform across GitLab + GitHub with no per-provider
/// API-param differences. Missing values (no milestone due date / no weight)
/// always sort LAST, regardless of direction — they're "unset", not extremes.
enum RepoIssueSort: String, CaseIterable, Identifiable {
    case created, updated, milestone, title, weight

    var id: String { rawValue }

    var label: String {
        switch self {
        case .created:   return "Created date"
        case .updated:   return "Updated date"
        case .milestone: return "Milestone"
        case .title:     return "Title"
        case .weight:    return "Weight"
        }
    }

    static func sorted(_ issues: [RepoIssue], by sort: RepoIssueSort, ascending: Bool) -> [RepoIssue] {
        switch sort {
        case .created:
            return issues.sorted { cmp($0.createdAt, $1.createdAt, ascending) }
        case .updated:
            return issues.sorted { cmp($0.updatedAt, $1.updatedAt, ascending) }
        case .title:
            return issues.sorted {
                let r = $0.title.localizedCaseInsensitiveCompare($1.title)
                return ascending ? r == .orderedAscending : r == .orderedDescending
            }
        case .milestone:
            // "yyyy-MM-dd" strings are lexically chronological; nil sorts last.
            return sortedKeepingNilLast(issues, key: { $0.milestone?.dueDate }, ascending: ascending,
                                        less: { $0 < $1 })
        case .weight:
            return sortedKeepingNilLast(issues, key: { $0.weight }, ascending: ascending,
                                        less: { $0 < $1 })
        }
    }

    // ISO8601 / date strings of the same format compare lexically = chronologically.
    private static func cmp(_ a: String, _ b: String, _ ascending: Bool) -> Bool {
        ascending ? a < b : a > b
    }

    /// Sort by an optional key, always pushing nil to the end. Non-nil values
    /// compare via `less`, flipped for descending; nils never move to the top.
    private static func sortedKeepingNilLast<T, K>(
        _ items: [T], key: (T) -> K?, ascending: Bool, less: (K, K) -> Bool
    ) -> [T] {
        items.sorted { lhs, rhs in
            switch (key(lhs), key(rhs)) {
            case let (l?, r?): return ascending ? less(l, r) : less(r, l)
            case (nil, _?):    return false   // nil after non-nil
            case (_?, nil):    return true    // non-nil before nil
            case (nil, nil):   return false   // stable
            }
        }
    }
}

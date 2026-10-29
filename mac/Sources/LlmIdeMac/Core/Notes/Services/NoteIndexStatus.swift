import Combine
import Foundation

/// What the note index could not index on the last pass, for the one quiet line a view may show.
/// Core owns it so no feature names the reconciler: the reconciler records each pass, and any
/// feature view reads `summary`. Counts only; no note text or paths are kept here.
@MainActor
final class NoteIndexStatusCenter: ObservableObject {
    static let shared = NoteIndexStatusCenter()

    /// Notes held back from pruning and not indexed, by reason (unparseable, unavailable, unsendable, oversize).
    @Published private(set) var kept: [String: Int] = [:]
    /// When the last complete pass ran.
    @Published private(set) var lastPassAt: Date?
    /// Pruned notes that came back within the flap window, summed over recent passes.
    @Published private(set) var flaps = 0
    /// True while an empty folder awaits its confirming pass (nothing is pruned yet).
    @Published private(set) var emptyPending = false

    init() {}

    /// Records a completed pass.
    func record(_ stats: NoteIndexReconciler.Stats, at date: Date) {
        kept = stats.keptByReason
        lastPassAt = date
        flaps = stats.flaps
        emptyPending = stats.emptyPending
    }

    /// The count of notes not indexed (kept back from pruning, not yet in the index).
    var unindexedCount: Int { kept.values.reduce(0, +) }

    /// "N notes could not be indexed: 2 unreadable frontmatter, 1 not downloaded" or nil when none.
    var summary: String? {
        let total = unindexedCount
        guard total > 0 else { return nil }
        let reasons = kept.sorted { $0.key < $1.key }
            .map { "\($0.value) \(Self.label(for: $0.key))" }
            .joined(separator: ", ")
        return "\(total) \(total == 1 ? "note" : "notes") could not be indexed: \(reasons)"
    }

    static func label(for reason: String) -> String {
        switch reason {
        case "unparseable": return "with unreadable frontmatter"
        case "unavailable": return "not downloaded to this Mac"
        case "unsendable": return "too large to upload"
        case "oversize": return "larger than 512 KB"
        default: return reason
        }
    }
}

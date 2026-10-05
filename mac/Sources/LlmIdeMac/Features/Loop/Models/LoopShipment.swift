import Foundation

/// What happened to a run's edits after it succeeded: pushed as a branch with a
/// merge request, deliberately left alone, or failed on the way. Journaled with
/// the run, so a past run says where its fix went.
struct LoopShipment: Codable, Equatable {
    enum Status: String, Codable {
        /// A merge request is open.
        case shipped
        /// Not shipped on purpose — a rule, not a fault (not allowed, a worktree
        /// run, no project linked to the folder). The summary says which.
        case skipped
        /// Something failed; the summary says what state it left behind.
        case failed
    }

    var status: Status
    /// One sentence for the log and the run page.
    var summary: String
    var mergeRequestURL: String? = nil
    var branch: String? = nil
    /// The files that were committed (shipped only).
    var files: [String] = []
}

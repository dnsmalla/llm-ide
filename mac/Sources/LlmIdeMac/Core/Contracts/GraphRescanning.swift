import Foundation

/// What a graph rescan asked of the code-graph feature came back with.
///
/// Lives in `Core/Contracts` so the Loop can name the outcome without naming
/// CodeGraph. `.busy` and `.unavailable` are both soft: the Loop proceeds with
/// the graph it has and says so in its log.
public enum GraphRescanOutcome: Equatable, Sendable {
    /// `<repoRoot>/system/graph/graph.json` was regenerated.
    case rewritten
    /// Another scan of the same repository was already running.
    case busy
    /// The graph could not be regenerated; the associated text says why.
    case unavailable(String)
}

/// Regenerates a repository's code graph on demand, so a Loop run can plan
/// against the current code instead of a stale `graph.json`.
public protocol GraphRescanning: AnyObject {
    /// Regenerate `<repoRoot>/system/graph/graph.json`. Never throws; returns why it could not.
    func rescan(repoRoot: URL) async -> GraphRescanOutcome
}

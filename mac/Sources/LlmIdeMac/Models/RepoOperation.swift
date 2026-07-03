import Foundation

/// A repo operation the app can perform on behalf of the user. Membership in a
/// provider's allow-list (`AppConfig.gitHubAllowedOps` / `gitLabAllowedOps`)
/// gates BOTH automated execution and the matching manual button.
enum RepoOperation: String, Codable, CaseIterable {
    case sync          // pull / re-sync / clone
    case push
    case createBranch
    case autoCommit
    case createIssue   // create issue/ticket, incl. tracker dispatch
    case commentIssue
    case createPR      // create PR / MR
    case merge         // merge / close PR / MR

    var label: String {
        switch self {
        case .sync:         return "Pull / Re-sync"
        case .push:         return "Push"
        case .createBranch: return "Create branch"
        case .autoCommit:   return "Auto-commit AI changes"
        case .createIssue:  return "Create issue"
        case .commentIssue: return "Comment on issue"
        case .createPR:     return "Create PR / MR"
        case .merge:        return "Merge / close"
        }
    }

    /// UI grouping — display only; the stored model stays a flat set.
    static var groups: [(String, [RepoOperation])] {
        [
            ("Sync",        [.sync]),
            ("Code writes", [.push, .createBranch, .autoCommit]),
            ("Issues",      [.createIssue, .commentIssue]),
            ("PR / MR",     [.createPR, .merge]),
        ]
    }
}

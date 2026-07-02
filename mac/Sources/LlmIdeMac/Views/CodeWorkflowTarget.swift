import Foundation
import RepoKit

/// Backend-neutral descriptor the Code-change sheets (`CodeWorkflowSheet`,
/// `QuickFixSheet`) need to drive `CodeWorkflowService` against either GitLab
/// or GitHub. Built at the call site from whichever saved project is
/// active + cloned — the service itself is already backend-agnostic, this is
/// the small bundle of UI-side state (which client, which project id, the
/// local clone path, push token) that selects the backend.
struct CodeWorkflowTarget {
    let kind: RepoBackendKind
    let backend: RepoBackend
    /// Numeric string for GitLab, "owner/name" for GitHub.
    let projectId: String
    /// False when the backend project hasn't been resolved yet (GitLab needs a
    /// numeric id; an unresolved project can't list/create issues). Gates the
    /// "pick existing issue" picker so it shows a clear message instead of a
    /// confusing API error.
    let isResolved: Bool
    let localURL: URL
    let defaultBranch: String
    let displayName: String
    /// Resolved lazily so a token change is picked up at push time.
    let pushToken: () -> String

    @MainActor
    static func gitLab(_ p: SavedGitLabProject, config: AppConfig) -> CodeWorkflowTarget {
        CodeWorkflowTarget(
            kind: .gitlab,
            backend: GitLabClient(config: config),
            projectId: String(p.resolvedId ?? 0),
            isResolved: p.resolvedId != nil,
            localURL: p.localURL ?? URL(fileURLWithPath: "/"),
            defaultBranch: p.defaultBranch ?? "main",
            displayName: p.displayName,
            pushToken: { (try? GitLabClient.currentToken()) ?? "" }
        )
    }

    @MainActor
    static func gitHub(_ r: SavedGitHubRepo, config: AppConfig) -> CodeWorkflowTarget {
        let pid: String
        if let (owner, name) = GitHubClient.ownerAndName(from: r.url) {
            pid = "\(owner)/\(name)"
        } else {
            pid = r.url
        }
        return CodeWorkflowTarget(
            kind: .github,
            backend: GitHubClient(config: config),
            projectId: pid,
            isResolved: !pid.isEmpty,
            localURL: r.localURL ?? URL(fileURLWithPath: "/"),
            defaultBranch: r.defaultBranch ?? "main",
            displayName: r.displayName,
            pushToken: { (try? GitHubClient.currentToken()) ?? "" }
        )
    }

    /// The active + cloned repo, GitLab first then GitHub — same precedence as
    /// `resolveIssueTarget` / ReviewView's `linkedCodeRepo`. The workflow does
    /// local git ops, so an uncloned project is intentionally excluded.
    @MainActor
    static func resolveActive(config: AppConfig) -> CodeWorkflowTarget? {
        if let p = config.gitLabSavedProjects.first(where: { $0.isActive && $0.isCloned }) {
            return .gitLab(p, config: config)
        }
        if let r = config.gitHubSavedRepos.first(where: { $0.isActive && $0.isCloned }) {
            return .gitHub(r, config: config)
        }
        return nil
    }

    /// True when an active + cloned repo exists — cheap gate for button
    /// enablement without constructing a backend client.
    @MainActor
    static func hasActive(config: AppConfig) -> Bool {
        config.gitLabSavedProjects.contains(where: { $0.isActive && $0.isCloned })
            || config.gitHubSavedRepos.contains(where: { $0.isActive && $0.isCloned })
    }
}

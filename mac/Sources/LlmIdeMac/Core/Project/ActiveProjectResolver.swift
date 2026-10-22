import Foundation

/// Derives the agent-facing "active project" (`AgentContext.Project`) from the
/// two places a user can configure one: the open workspace bundle's linked
/// repo, and the Settings → GitLab / GitHub active project.
///
/// Lives in Core because its inputs (`ProjectStore.ActiveProject`,
/// `AppConfig`) and output (`AgentContext`) are all Core, and more than one
/// feature needs the same answer: Chat builds the agent context from it and
/// Issues keys its recent-issues fetch on it. Chat's
/// `CodeAssistantPanel.deriveActiveProject` statics forward here.
enum ActiveProjectResolver {
    /// Pure derivation: maps an active workspace project (if any) to an
    /// `AgentContext.Project`.
    ///
    /// - Post: nil when there is no active project or its bundle has no
    ///   `linkedRepo`; otherwise the bundle's display name + the linked repo's
    ///   url / default branch, provider "GitLab" or "GitHub".
    static func project(from active: ProjectStore.ActiveProject?) -> AgentContext.Project? {
        guard let active, let linked = active.bundle.settings.linkedRepo else { return nil }
        return AgentContext.Project(
            name: active.bundle.displayName,
            url: linked.url,
            defaultBranch: linked.defaultBranch,
            provider: linked.kind == .gitlab ? "GitLab" : "GitHub")
    }

    /// Fallback derivation for users who configured a repo via
    /// Settings → GitLab / GitHub (which populates `config.gitLabSavedProjects`
    /// / `config.gitHubSavedRepos`) but whose open workspace bundle has no
    /// `linkedRepo`. Without this, the agent's System context reports
    /// "(none configured)" and the create-issue skill refuses — even though
    /// `resolveIssueTarget()` could file the issue. Mirrors that resolver's
    /// precedence (GitLab first, then GitHub, via `activeConfigRepo`) so the
    /// agent's view of the active project matches where issues get filed.
    ///
    /// - Post: nil when no config repo is active; otherwise its display name
    ///   (or the url's last path component when the name is empty).
    static func project(fromConfig config: AppConfig) -> AgentContext.Project? {
        switch config.activeConfigRepo {
        case .gitlab(let p):
            let name = !p.displayName.isEmpty ? p.displayName
                : (URL(string: p.url)?.lastPathComponent ?? "project")
            return AgentContext.Project(name: name, url: p.url,
                                        defaultBranch: p.defaultBranch, provider: "GitLab")
        case .github(let r):
            let name = !r.displayName.isEmpty ? r.displayName
                : (URL(string: r.url)?.lastPathComponent ?? "repository")
            return AgentContext.Project(name: name, url: r.url,
                                        defaultBranch: r.defaultBranch, provider: "GitHub")
        case nil:
            return nil
        }
    }
}

import Foundation

/// The open issues an agent turn is grounded in — the `## Recent open issues`
/// block the server renders from `AgentContext.recentIssues`
/// (llm_agent/internal/context/render-recent-issues.mjs).
///
/// Exists because that block is the ONLY way an agent learns about issues:
/// there is no issue-reading tool in the registry, so a turn whose context
/// carries no issues cannot go and get them. "List the issues" then answers
/// from nothing.
///
/// That is exactly what happened between surfaces. The Mac panel fetched them
/// (`refreshRecentIssuesOnce`) and passed them on every turn; the phone's
/// bridge hard-coded `recentIssues: nil`, so the same prompt listed issues on
/// the Mac and listed nothing from the phone. One resolver, both callers — a
/// second copy of "which project's issues, and how do I fetch them" is how the
/// two drifted in the first place.
@MainActor
enum RecentIssuesResolver {

    /// Cached result, so a phone turn moments after a Mac refresh costs no
    /// network. Short by design: issues change, and a stale list read as
    /// current is worse than a slow one.
    private static var cache: (issues: [AgentContext.RecentIssue], at: Date)?
    static let freshness: TimeInterval = 120

    /// The issues to ground a turn in, fetching only when the cache is cold or
    /// stale. For callers that have no refresh loop of their own — the phone.
    static func contextIssues(config: AppConfig, projectStore: ProjectStore) async
        -> [AgentContext.RecentIssue]
    {
        if let cache, Date().timeIntervalSince(cache.at) < freshness { return cache.issues }
        return await fetch(config: config, projectStore: projectStore)
    }

    /// Fetch now, ignoring the cache, and store the result. The Mac panel's
    /// own refresh path — it decides when (on appear, after creating an
    /// issue), and the phone rides the result.
    @discardableResult
    static func fetch(config: AppConfig, projectStore: ProjectStore) async
        -> [AgentContext.RecentIssue]
    {
        let issues = await load(config: config, projectStore: projectStore)
        cache = (issues, Date())
        return issues
    }

    /// Drop the cache — a project switch makes the list belong to a repo the
    /// user is no longer looking at.
    static func invalidate() { cache = nil }

    // MARK: - The fetch itself

    private static func load(config: AppConfig, projectStore: ProjectStore) async
        -> [AgentContext.RecentIssue]
    {
        let workspaceProject = CodeAssistantPanel.deriveActiveProject(from: projectStore.activeProject)
        let configProject = CodeAssistantPanel.deriveActiveProject(fromConfig: config)
        guard let activeProject = workspaceProject ?? configProject,
              let provider = activeProject.provider else { return [] }
        // The workspace's linked repo and the Settings-active project can
        // disagree; the fetch below is keyed on the latter, so serving its
        // issues for the former would hand the agent a DIFFERENT project's
        // list. Empty rather than wrong.
        if let workspaceProject, let configProject, workspaceProject.url != configProject.url {
            return []
        }

        let backend: RepoBackend
        let projectId: String
        if provider == "GitLab" {
            guard let project = config.gitLabSavedProjects.first(where: { $0.isActive }),
                  let pid = project.resolvedId else { return [] }
            backend = RepoBackendFactory.backend(for: .gitlab, config: config)
            projectId = String(pid)
        } else if provider == "GitHub" {
            guard let repo = config.gitHubSavedRepos.first(where: { $0.isActive }),
                  let (owner, name) = GitHubClient.ownerAndName(from: repo.url) else { return [] }
            backend = RepoBackendFactory.backend(for: .github, config: config)
            projectId = "\(owner)/\(name)"
        } else {
            return []
        }

        do {
            // Open issues only: that's what the user actively references.
            // Closed issues clutter the prompt without much upside.
            let filter = RepoIssueFilter(state: .opened, search: "", labelName: "")
            let issues = try await backend.listIssues(projectId: projectId, filter: filter, page: 1)
            // Cap at 15, most-recently-updated first, so the prompt context
            // doesn't blow up.
            return issues
                .sorted { $0.updatedAt > $1.updatedAt }
                .prefix(15)
                .map { issue in
                    let desc = issue.body ?? ""
                    return AgentContext.RecentIssue(
                        iid: issue.number,          // GitLab iid / GitHub number
                        title: issue.title,
                        state: issue.state,         // "opened" / "closed"
                        labels: issue.labels,
                        snippet: desc.isEmpty ? nil : String(desc.prefix(160)),
                        updatedAt: issue.updatedAt)
                }
        } catch {
            // Don't surface — the turn just carries no issues.
            return []
        }
    }
}

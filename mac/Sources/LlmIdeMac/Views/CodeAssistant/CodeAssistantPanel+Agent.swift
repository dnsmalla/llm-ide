import SwiftUI

extension CodeAssistantPanel {

    /// Candidate repo paths ("~/…") for the project-memory viewer. The server
    /// resolves the first allow-listed one (the agent's actual write target),
    /// so we hand it the full indexedRepos list rather than guessing first.
    internal var activeMemoryRepos: [String] {
        let codeItems = library.items(for: .code)
        let grouped = Dictionary(grouping: codeItems.filter { $0.folderOrigin != nil },
                                 by: { $0.folderOrigin! })
        return grouped.keys.sorted().compactMap { folder in
            let items = grouped[folder] ?? []
            let ancestor = commonAncestor(items.map { $0.path })
            return ancestor.isEmpty ? nil : homeRelativePath(ancestor)
        }
    }

    /// The open Explorer folder ("~/…") for the project-memory viewer, so memory
    /// resolves to the open project even when it isn't a formally-indexed repo.
    internal var activeMemoryWorkspaceRoot: String? {
        WorkspaceRoot.resolve(config: config, projectStore: projectStore)
            .map { homeRelativePath($0.path) }
    }

    // MARK: - Agent context

    /// Pure derivation: maps an active project (if any) to an
    /// AgentContext.Project. Extracted as a static fn so unit tests can
    /// exercise the conversion without instantiating a SwiftUI view.
    static func deriveActiveProject(from active: ProjectStore.ActiveProject?) -> AgentContext.Project? {
        guard let active, let linked = active.bundle.settings.linkedRepo else { return nil }
        return AgentContext.Project(
            name: active.bundle.displayName,
            url: linked.url,
            defaultBranch: linked.defaultBranch,
            provider: linked.kind == .gitlab ? "GitLab" : "GitHub")
    }

    /// Fallback active-project derivation for users who configured a repo via
    /// Settings → GitLab / GitHub (which populates `config.gitLabSavedProjects`
    /// / `config.gitHubSavedRepos`) but whose open workspace bundle has no
    /// `linkedRepo`. Without this, the agent's System context reports
    /// "(none configured)" and the create-issue skill refuses — even though
    /// `resolveIssueTarget()` could file the issue. Mirrors that resolver's
    /// precedence (GitLab first, then GitHub) so the agent's view of the
    /// active project matches where issues actually get filed.
    static func deriveActiveProject(fromConfig config: AppConfig) -> AgentContext.Project? {
        if !config.gitLabToken.isEmpty,
           let p = config.gitLabSavedProjects.first(where: { $0.isActive }) {
            let name = !p.displayName.isEmpty ? p.displayName
                : (URL(string: p.url)?.lastPathComponent ?? "project")
            return AgentContext.Project(name: name, url: p.url,
                                        defaultBranch: p.defaultBranch, provider: "GitLab")
        }
        if !config.gitHubToken.isEmpty,
           let r = config.gitHubSavedRepos.first(where: { $0.isActive }) {
            let name = !r.displayName.isEmpty ? r.displayName
                : (URL(string: r.url)?.lastPathComponent ?? "repository")
            return AgentContext.Project(name: name, url: r.url,
                                        defaultBranch: r.defaultBranch, provider: "GitHub")
        }
        return nil
    }

    /// Builds the per-request snapshot of "what the agent should know":
    /// the active GitLab project and the user's indexed code repos.
    /// Recomputed every send so Settings changes are picked up live.
    func buildAgentContext() async -> AgentContext {
        // New: derive from the active workspace's linkedRepo. Falls
        // through to nil when no project is open (Welcome screen path)
        // or when the active project has no linked repo set. Existing
        // AgentContext.Project shape is preserved so the server-side
        // render-active-project skill renders identically.
        // Prefer the open workspace's linkedRepo; fall back to the active
        // Settings → GitLab/GitHub connection so a project configured only
        // there is still visible to the agent (otherwise it reports
        // "(none configured)" and the create-issue skill refuses to act).
        let activeProject = Self.deriveActiveProject(from: projectStore.activeProject)
            ?? Self.deriveActiveProject(fromConfig: config)
        let codeItems = library.items(for: .code)
        let grouped = Dictionary(grouping: codeItems.filter { $0.folderOrigin != nil },
                                 by: { $0.folderOrigin! })
        let indexedRepos: [AgentContext.IndexedRepo] = grouped.keys.sorted().map { folder in
            let items = grouped[folder] ?? []
            let ancestor = commonAncestor(items.map { $0.path })
            return .init(name: folder, path: ancestor.isEmpty ? nil : homeRelativePath(ancestor))
        }
        // NOTE: `recentIssues` is populated by the issue-polling flow
        // (refreshRecentIssuesOnce) which reads the legacy Settings-active
        // project (config.gitLabSavedProjects / gitHubSavedRepos). When that
        // diverges from the workspace's linkedRepo (the activeProject above),
        // refreshRecentIssuesOnce now clears recentIssues rather than serving
        // another project's issues. Fetching issues for the workspace-linkedRepo
        // project itself (GitLab URL→id resolution) is the remaining Phase 2 work.
        // The folder open in the Explorer — the server scopes its read-only
        // file tools (list-files / read-file) to this root + the indexed repos,
        // so "find the README and review it" can resolve a real file.
        let workspaceRoot = WorkspaceRoot.resolve(config: config, projectStore: projectStore)
            .map { homeRelativePath($0.path) }

        // Git context: populate currentBranch and gitStatus so the agent
        // can answer repo-state questions without a git-op tool call.
        // Resolved from the active repo URL; nil when not in a git repo.
        var gitBranch: String?
        var gitStatus: AgentContext.GitStatus?
        if let repoURL = config.activeRepoLocalURL, WorkspaceRoot.isGitRepo(repoURL) {
            let repoManager = RepoManager()
            // Get current branch
            if let branch = try? await repoManager.runGit(["rev-parse", "--abbrev-ref", "HEAD"], at: repoURL) {
                gitBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            // Get status counts (porcelain v1: XY filename)
            if let status = try? await repoManager.runGit(["status", "--porcelain=v1"], at: repoURL) {
                let lines = status.split(separator: "\n")
                let staged = lines.filter { $0.prefix(1) != " " && $0.prefix(1) != "?" }.count
                let unstaged = lines.filter { $0.count >= 2 && $0.dropFirst().prefix(1) != " " }.count
                // Get ahead/behind from branch tracking
                var ahead = 0, behind = 0, hasUpstream = false
                if let branch = gitBranch,
                   let tracking = try? await repoManager.runGit(["rev-parse", "--abbrev-ref", "\(branch)@{upstream}"], at: repoURL),
                   !tracking.contains("no upstream") {
                    hasUpstream = true
                    let counts = try? await repoManager.runGit(["rev-list", "--left-right", "--count", "\(branch)...@{u}"], at: repoURL)
                    if let counts = counts {
                        let parts = counts.split(separator: "\t").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        if parts.count == 2 {
                            ahead = Int(parts[0]) ?? 0
                            behind = Int(parts[1]) ?? 0
                        }
                    }
                }
                gitStatus = AgentContext.GitStatus(
                    staged: staged,
                    unstaged: unstaged,
                    ahead: ahead,
                    behind: behind,
                    hasUpstream: hasUpstream
                )
            }
        }

        return AgentContext(
            activeProject: activeProject,
            indexedRepos: indexedRepos,
            recentIssues: recentIssues.isEmpty ? nil : recentIssues,
            workspaceRoot: workspaceRoot,
            sessionId: agentSessionId,
            currentBranch: gitBranch,
            gitStatus: gitStatus
        )
    }

    /// Polls GitLab for the active project's recent issues and updates
    /// `recentIssues`. Runs once on panel mount and every 60 s while
    /// alive. Silently no-ops when no project is configured or the
    /// project ID hasn't been resolved yet.
    func refreshRecentIssuesLoop() async {
        while !Task.isCancelled {
            await refreshRecentIssuesOnce()
            // 60 s between polls — issues don't change fast enough to
            // justify hammering the GitLab API.
            try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
        }
    }

    func refreshRecentIssuesOnce() async {
        // Determine the active project and its provider
        let workspaceProject = Self.deriveActiveProject(from: projectStore.activeProject)
        let configProject = Self.deriveActiveProject(fromConfig: config)
        guard let activeProject = workspaceProject ?? configProject,
              let provider = activeProject.provider else {
            recentIssues = []
            return
        }
        // If the workspace's linkedRepo is the active project and it isn't the
        // same as the legacy Settings-active project, the config-based fetch
        // below would hand the agent a DIFFERENT project's issues (mismatched
        // context). Clear rather than serve wrong data; resolving the workspace
        // GitLab URL→id for a proper fetch is the remaining Phase 2 work.
        if let workspaceProject, let configProject,
           workspaceProject.url != configProject.url {
            recentIssues = []
            return
        }

        // Create the appropriate RepoBackend based on provider
        let backend: RepoBackend
        let projectId: String

        if provider == "GitLab" {
            guard let project = config.gitLabSavedProjects.first(where: { $0.isActive }),
                  let pid = project.resolvedId else {
                recentIssues = []
                return
            }
            backend = RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
            projectId = String(pid)
        } else if provider == "GitHub" {
            guard let repo = config.gitHubSavedRepos.first(where: { $0.isActive }),
                  let (owner, name) = GitHubClient.ownerAndName(from: repo.url) else {
                recentIssues = []
                return
            }
            backend = RepoBackendFactory.guarded(GitHubClient(config: config), config: config)
            projectId = "\(owner)/\(name)"
        } else {
            recentIssues = []
            return
        }

        do {
            // Open issues only: that's what the user actively references.
            // Closed issues clutter the prompt without much upside.
            let filter = RepoIssueFilter(state: .opened, search: "", labelName: "")
            let issues = try await backend.listIssues(projectId: projectId, filter: filter, page: 1)

            // Cap at 15 so the prompt context doesn't blow up; pick the
            // most recently updated. Sort by updatedAt (descending).
            let capped = Array(
                issues
                    .sorted { $0.updatedAt > $1.updatedAt }
                    .prefix(15)
            )

            recentIssues = capped.map { issue in
                let desc = issue.body ?? ""
                let snippet = desc.isEmpty ? nil : String(desc.prefix(160))
                return AgentContext.RecentIssue(
                    iid: issue.number,  // Use `number` (GitLab iid, GitHub number)
                    title: issue.title,
                    state: issue.state,   // "opened" / "closed"
                    labels: issue.labels,
                    snippet: snippet,
                    updatedAt: issue.updatedAt
                )
            }
        } catch {
            // Don't surface — agent just sees an empty list this turn.
            recentIssues = []
        }
    }

    func commonAncestor(_ paths: [String]) -> String {
        guard !paths.isEmpty else { return "" }
        let split = paths.map { $0.components(separatedBy: "/") }
        let shortest = split.min(by: { $0.count < $1.count }) ?? []
        var result: [String] = []
        for i in 0..<shortest.count {
            let c = shortest[i]
            if split.allSatisfy({ $0.indices.contains(i) && $0[i] == c }) { result.append(c) }
            else { break }
        }
        return result.joined(separator: "/")
    }

    func homeRelativePath(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if p.hasPrefix(home) { return "~" + p.dropFirst(home.count) }
        return p
    }

}

import SwiftUI

/// The repo state `buildAgentContext` sends with each turn.
struct AgentGitSnapshot: Sendable {
    var branch: String?
    var status: AgentContext.GitStatus?
}

/// Very-short-lived memo of the last `AgentGitSnapshot`, so a burst of turns
/// doesn't re-spawn the same `git` processes.
///
/// `buildAgentContext` runs on the send path of EVERY round-trip, and each
/// call shells out to `git` up to four times — on a large repo, `git status`
/// alone is a visible pause between hitting send and anything happening. An
/// autonomous chain makes that worse: `runTurn`, each `sendFollowup`, and each
/// auto-continue turn all rebuild the context within seconds of each other,
/// re-running identical commands against a repo that hasn't changed.
///
/// The TTL is deliberately short. Git state genuinely DOES change mid-chain —
/// the agent commits, branches, pushes — so this is sized to collapse a burst
/// of near-simultaneous turns, not to hold a snapshot across one.
@MainActor
enum AgentGitSnapshotCache {
    /// Long enough to cover a round-trip's own follow-ups, short enough that
    /// the agent's own git ops are reflected in the next turn's context.
    static let ttl: TimeInterval = 3

    private static var cachedRepo: URL?
    private static var cachedSnapshot: AgentGitSnapshot?
    private static var cachedAt: Date?

    static func snapshot(for repo: URL, now: Date = Date()) -> AgentGitSnapshot? {
        guard cachedRepo == repo, let at = cachedAt, let snapshot = cachedSnapshot,
              now.timeIntervalSince(at) < ttl else { return nil }
        return snapshot
    }

    static func store(_ snapshot: AgentGitSnapshot, for repo: URL, now: Date = Date()) {
        cachedRepo = repo
        cachedSnapshot = snapshot
        cachedAt = now
    }

    /// Drop the memo — used when the active repo changes, so the next turn
    /// can't be served a snapshot of the repo the user just navigated away from.
    static func invalidate() {
        cachedRepo = nil
        cachedSnapshot = nil
        cachedAt = nil
    }
}

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
        // NOTE: `engine.agent.recentIssues` is populated by the issue-polling flow
        // (refreshRecentIssuesOnce) which reads the legacy Settings-active
        // project (config.gitLabSavedProjects / gitHubSavedRepos). When that
        // diverges from the workspace's linkedRepo (the activeProject above),
        // refreshRecentIssuesOnce now clears engine.agent.recentIssues rather than serving
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
            let snapshot: AgentGitSnapshot
            if let cached = AgentGitSnapshotCache.snapshot(for: repoURL) {
                snapshot = cached
            } else {
                snapshot = await Self.readGitSnapshot(at: repoURL)
                AgentGitSnapshotCache.store(snapshot, for: repoURL)
            }
            gitBranch = snapshot.branch
            gitStatus = snapshot.status
        }

        return AgentContext(
            activeProject: activeProject,
            indexedRepos: indexedRepos,
            recentIssues: engine.agent.recentIssues.isEmpty ? nil : engine.agent.recentIssues,
            workspaceRoot: workspaceRoot,
            sessionId: engine.agent.agentSessionId,
            chatSessionId: engine.currentSessionIDString.isEmpty ? nil : engine.currentSessionIDString,
            currentBranch: gitBranch,
            gitStatus: gitStatus
        )
    }

    /// Read the repo's branch + worktree status for the agent's context.
    ///
    /// Branch and status are independent, so they run concurrently rather than
    /// back to back — `RepoManager` runs each `git` on a background queue, so
    /// two in flight really do overlap. The upstream lookups have to follow,
    /// since they need the branch name. Three rounds instead of four, and (via
    /// `AgentGitSnapshotCache`) usually zero.
    static func readGitSnapshot(at repoURL: URL) async -> AgentGitSnapshot {
        let repoManager = RepoManager()
        async let branchOut = try? repoManager.runGit(["rev-parse", "--abbrev-ref", "HEAD"], at: repoURL)
        async let statusOut = try? repoManager.runGit(["status", "--porcelain=v1"], at: repoURL)

        let branch = (await branchOut)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let status = await statusOut else {
            return AgentGitSnapshot(branch: branch, status: nil)
        }

        // Status counts (porcelain v1: XY filename).
        let lines = status.split(separator: "\n")
        let staged = lines.filter { $0.prefix(1) != " " && $0.prefix(1) != "?" }.count
        let unstaged = lines.filter { $0.count >= 2 && $0.dropFirst().prefix(1) != " " }.count

        // Ahead/behind from branch tracking.
        var ahead = 0, behind = 0, hasUpstream = false
        if let branch,
           let tracking = try? await repoManager.runGit(["rev-parse", "--abbrev-ref", "\(branch)@{upstream}"], at: repoURL),
           !tracking.contains("no upstream") {
            hasUpstream = true
            if let counts = try? await repoManager.runGit(["rev-list", "--left-right", "--count", "\(branch)...@{u}"], at: repoURL) {
                let parts = counts.split(separator: "\t").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                if parts.count == 2 {
                    ahead = Int(parts[0]) ?? 0
                    behind = Int(parts[1]) ?? 0
                }
            }
        }
        return AgentGitSnapshot(
            branch: branch,
            status: AgentContext.GitStatus(
                staged: staged,
                unstaged: unstaged,
                ahead: ahead,
                behind: behind,
                hasUpstream: hasUpstream))
    }

    /// Polls GitLab for the active project's recent issues and updates
    /// `engine.agent.recentIssues`. Runs once on panel mount and every 60 s while
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
            engine.agent.recentIssues = []
            return
        }
        // If the workspace's linkedRepo is the active project and it isn't the
        // same as the legacy Settings-active project, the config-based fetch
        // below would hand the agent a DIFFERENT project's issues (mismatched
        // context). Clear rather than serve wrong data; resolving the workspace
        // GitLab URL→id for a proper fetch is the remaining Phase 2 work.
        if let workspaceProject, let configProject,
           workspaceProject.url != configProject.url {
            engine.agent.recentIssues = []
            return
        }

        // Create the appropriate RepoBackend based on provider
        let backend: RepoBackend
        let projectId: String

        if provider == "GitLab" {
            guard let project = config.gitLabSavedProjects.first(where: { $0.isActive }),
                  let pid = project.resolvedId else {
                engine.agent.recentIssues = []
                return
            }
            backend = RepoBackendFactory.backend(for: .gitlab, config: config)
            projectId = String(pid)
        } else if provider == "GitHub" {
            guard let repo = config.gitHubSavedRepos.first(where: { $0.isActive }),
                  let (owner, name) = GitHubClient.ownerAndName(from: repo.url) else {
                engine.agent.recentIssues = []
                return
            }
            backend = RepoBackendFactory.backend(for: .github, config: config)
            projectId = "\(owner)/\(name)"
        } else {
            engine.agent.recentIssues = []
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

            engine.agent.recentIssues = capped.map { issue in
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
            engine.agent.recentIssues = []
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
        PathUtils.homeRelative(p)
    }

}

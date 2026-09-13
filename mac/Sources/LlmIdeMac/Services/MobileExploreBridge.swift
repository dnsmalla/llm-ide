import Foundation
import SharedProtocol

/// Builds Mac-side code-assist inputs for iPhone `explore_chat` turns: the Mac
/// user's model/provider settings, workspace agent context, and file attachments
/// uploaded from the phone.
@MainActor
enum MobileExploreBridge {

    static func modelAndProvider(config: AppConfig?) -> (model: String?, provider: String?) {
        guard let config else {
            // When config is unavailable (early app init), default to Claude
            return (nil, AICliTool.claudeCode.provider)
        }
        let cli = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
        let model = config.defaultModelId.isEmpty ? nil : config.defaultModelId
        return (model, cli.provider)
    }

    static func attachments(from files: [ChatFileText]) -> [LlmIdeAPIClient.CodeAttachment] {
        files.map { LlmIdeAPIClient.CodeAttachment(path: $0.name, content: $0.text) }
    }

    /// Same workspace / project / git snapshot the Mac Explorer panel sends.
    /// `sessionId` is the phone-side explorer chat's stable ChatSession UUID —
    /// it fills BOTH `AgentContext.sessionId` (task-store correlation for the
    /// phone's turns) and `chatSessionId` (the field the server prefers for
    /// session-memory keying). The value is the same either way; sending the
    /// stable id explicitly keeps memory keying on the preferred field
    /// instead of the server's sessionId fallback, which only lined up
    /// because this caller happened to pass the chat UUID.
    /// The permission setting a phone-driven turn runs under: whatever the
    /// Mac's Code Assistant chip is set to, read through
    /// `EditAcceptanceMode.defaultsKey` — the same constant the panel's own
    /// `@AppStorage` binds — and mapped by `agentPermissionMode`.
    ///
    /// Inherited rather than invented so there is ONE place to change it and
    /// one answer to "what will a message from my phone be allowed to do" —
    /// the chip you can see on the Mac. Without it a phone turn sent no
    /// permission at all, the server asked for every write, and the phone has
    /// no way to answer a ToolApproval: the turn hung until the 15-minute
    /// park expired, which is what "execution doesn't work from the phone"
    /// looked like.
    ///
    /// Note what it does NOT lift: the server's hard rails stand either way —
    /// a blocklisted command and a write outside the workspace are refused on
    /// bypass exactly as on manual.
    static func permissionMode() -> String {
        let raw = UserDefaults.standard.string(forKey: EditAcceptanceMode.defaultsKey) ?? ""
        return (EditAcceptanceMode(rawValue: raw) ?? .review).agentPermissionMode
    }

    static func buildAgentContext(config: AppConfig, projectStore: ProjectStore,
                                  sessionId: String?) async -> AgentContext {
        let activeProject = deriveActiveProject(from: projectStore.activeProject)
            ?? deriveActiveProject(fromConfig: config)
        let workspaceRoot = WorkspaceRoot.resolve(config: config, projectStore: projectStore)
            .map { PathUtils.homeRelative($0.path) }

        var gitBranch: String?
        var gitStatus: AgentContext.GitStatus?
        if let repoURL = config.activeRepoLocalURL, WorkspaceRoot.isGitRepo(repoURL) {
            let repoManager = RepoManager()
            if let branch = try? await repoManager.runGit(["rev-parse", "--abbrev-ref", "HEAD"], at: repoURL) {
                gitBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let status = try? await repoManager.runGit(["status", "--porcelain=v1"], at: repoURL) {
                let lines = status.split(separator: "\n")
                let staged = lines.filter { $0.prefix(1) != " " && $0.prefix(1) != "?" }.count
                let unstaged = lines.filter { $0.count >= 2 && $0.dropFirst().prefix(1) != " " }.count
                var ahead = 0, behind = 0, hasUpstream = false
                if let branch = gitBranch,
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
                gitStatus = AgentContext.GitStatus(
                    staged: staged, unstaged: unstaged,
                    ahead: ahead, behind: behind, hasUpstream: hasUpstream)
            }
        }

        // The SAME issues the Mac panel passes. There is no issue-reading
        // tool in the registry — `## Recent open issues` is rendered purely
        // from this field — so a nil here meant a phone turn could not answer
        // "list the issues" at all, while the same prompt on the Mac could.
        // Cache-first: a phone turn moments after a Mac refresh costs nothing.
        let recentIssues = await RecentIssuesResolver.contextIssues(
            config: config, projectStore: projectStore)

        return AgentContext(
            activeProject: activeProject,
            // Not `[]`: that renders as "(none indexed)" — a false statement
            // — and, worse, makes `memory-persist.mjs` write this turn's
            // captured project memory to a different root than a Mac turn
            // would (it takes the first indexed repo, else the workspace).
            indexedRepos: IndexedReposResolver.externalRepos(config: config),
            recentIssues: recentIssues.isEmpty ? nil : recentIssues,
            workspaceRoot: workspaceRoot,
            sessionId: sessionId,
            chatSessionId: sessionId,
            currentBranch: gitBranch,
            gitStatus: gitStatus
        )
    }

    private static func deriveActiveProject(from active: ProjectStore.ActiveProject?) -> AgentContext.Project? {
        guard let active, let linked = active.bundle.settings.linkedRepo else { return nil }
        return AgentContext.Project(
            name: active.bundle.displayName,
            url: linked.url,
            defaultBranch: linked.defaultBranch,
            provider: linked.kind == .gitlab ? "GitLab" : "GitHub")
    }

    private static func deriveActiveProject(fromConfig config: AppConfig) -> AgentContext.Project? {
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

    static func homeRelativePathForDisplay(_ p: String) -> String {
        PathUtils.homeRelative(p)
    }
}

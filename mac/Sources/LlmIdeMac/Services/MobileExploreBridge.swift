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

        return AgentContext(
            activeProject: activeProject,
            indexedRepos: [],
            recentIssues: nil,
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

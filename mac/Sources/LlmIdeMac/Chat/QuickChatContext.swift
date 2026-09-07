import Foundation

/// What the quick chat (menu bar / LLM Chat sheet / iPhone) is aimed at.
///
/// One type, three consumers, deliberately: the surfaces must agree on which
/// project a turn targets AND on what they say when there is none. Two copies
/// of that answer drift, and the failure is silent — a chat answering about
/// the wrong repo looks exactly like a chat answering about the right one.
///
/// `resolve` returns nil when no project is active. That is not an error: the
/// code pipeline cannot run without a project (the server throws
/// `workspaceRoot is required`), so the surfaces decline rather than send a
/// request that must fail.
struct QuickChatContext {
    let projectId: String
    let agentContext: AgentContext

    /// Shown by all three surfaces, and sent to the phone as a normal reply —
    /// NOT as a CommandError, which the phone renders as a failure rather than
    /// as an answer.
    static let noProjectMessage =
        "Open a project to chat about your code. This chat answers from the "
        + "active project's code and memory, so it needs one to be open."

    /// `WorkspaceRoot.resolve` and `ProjectStore.activeProject` are both
    /// `@MainActor`-isolated (see `WorkspaceRoot.swift` / `ProjectStore.swift`),
    /// so this has to be too.
    @MainActor
    static func resolve(config: AppConfig, projectStore: ProjectStore) -> QuickChatContext? {
        guard let project = projectStore.activeProject else { return nil }
        guard let root = WorkspaceRoot.resolve(config: config, projectStore: projectStore) else { return nil }
        return QuickChatContext(
            // `bundle.id` is the project's persisted, stable identifier — the
            // same one every other per-project keying site in the app uses
            // (LoopEngineConfig, AutoTask, GraphSettingsSection, ...); it is
            // NOT derived from the folder path, which can move. `ActiveProject`
            // itself has no `id` of its own, only `bundle: Project` (which is
            // `Identifiable`) and `localPath`.
            projectId: project.bundle.id,
            // Same shape the Code Assistant panel and MobileExploreBridge send
            // (see CodeAssistantPanel+Agent.swift / MobileExploreBridge.swift):
            // the server scopes its read-only file tools to this root, so
            // "where is auth handled" can resolve a real file. `indexedRepos`
            // is left empty — it's an enhancement for the full panel, not a
            // requirement for a quick chat turn.
            agentContext: AgentContext(indexedRepos: [], workspaceRoot: PathUtils.homeRelative(root.path)))
    }
}

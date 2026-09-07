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

    /// The server `apiVersion` these three surfaces need — `extension/server.mjs`'s
    /// v47 entry, the `ask` mode. An older server does not recognize `ask` and
    /// silently resolves it to `execute`, handing full act tools to a window
    /// whose approvals may have nothing to render them. `BackendManager
    /// .minimumServerApiVersion` deliberately stays below this (see its doc
    /// comment): the unsafety is confined to these three `ask`-mode senders,
    /// so the gate lives here, not at the app-wide floor.
    static let requiredServerApiVersion = 47

    /// Whether a reported server `apiVersion` is known to support `ask`.
    ///
    /// `nil` — not yet probed, or the probe hasn't landed — FAILS CLOSED
    /// (returns `false`). Treating "unknown" as "supported" would let a turn
    /// race the first health probe and reach an old server before its
    /// version is even known, which is the exact unsafe fallback this gate
    /// exists to prevent.
    static func serverSupportsAsk(_ apiVersion: Int?) -> Bool {
        guard let apiVersion else { return false }
        return apiVersion >= requiredServerApiVersion
    }

    /// One shared message for all three surfaces (menu bar, sheet, phone) so
    /// the wording cannot drift between them.
    static func unsupportedServerMessage(apiVersion: Int?) -> String {
        guard let apiVersion else {
            return "This chat needs the LLM-IDE server's API v\(requiredServerApiVersion) or "
                + "newer, and the running server's version isn't known yet — try again in a "
                + "moment, or restart the server if this persists."
        }
        return "Restart the LLM-IDE server to use this chat — it needs API "
            + "v\(requiredServerApiVersion) and the running server is v\(apiVersion)."
    }

    /// Point the shared `.quick` engine at `projectId`. ONE answer for all
    /// three surfaces (menu bar, sheet, phone) — the same reason this type
    /// exists at all.
    ///
    /// No surface may assign `engine.quickChatProjectId` itself. The three
    /// cases below are not interchangeable, and a surface that pokes the id
    /// directly gets the third one wrong every time:
    ///
    ///  1. **Nothing loaded** (`currentSessionIDString.isEmpty`) — stamp the
    ///     id and resolve a session. Safe because there is no loaded session
    ///     to mis-pair with the new id, and `...IfReady()` declines (rather
    ///     than reading the `.quick` pointer with a nil id) when no project
    ///     is open.
    ///  2. **Loaded for a DIFFERENT project** — must go through
    ///     `switchQuickChatProject(to:)`, which persists the outgoing turn
    ///     while `quickChatProjectId` still names the OLD project and then
    ///     re-resolves the new one. Poking the id directly instead leaves
    ///     `currentSessionIDString` pointing at the OLD project's session
    ///     under the NEW project's pointer key, so every later turn is
    ///     appended to the previous project's file — and with a nil id
    ///     (project CLOSED, not switched) it reaches `pointerKey`'s
    ///     `assertionFailure` instead.
    ///  3. **Loaded for the same project** — nothing to swap; just refresh
    ///     the session list, exactly as both `.onAppear`s used to.
    ///
    /// The menu bar and the sheet call this from `.onAppear` AND from
    /// `.onChange(of: projectStore.activeProject)`: the engine is
    /// registry-cached and outlives both surfaces, so a project change while
    /// they are closed — or while the popover is open, where the composer
    /// gate re-evaluates live on `@Published activeProject` — must reach the
    /// engine too, or the gate and the engine disagree silently.
    @MainActor
    static func attach(_ engine: ChatEngine, toProject projectId: String?) {
        assert(engine.scope == .quick, "QuickChatContext.attach is for the .quick engine only")
        if engine.currentSessionIDString.isEmpty {
            engine.quickChatProjectId = projectId
            engine.handleOnAppearSessionsIfReady()
        } else if engine.quickChatProjectId != projectId {
            engine.switchQuickChatProject(to: projectId)
        } else {
            engine.refreshSessions()
        }
    }

    /// `attach(_:toProject:)` for a caller that has the stores rather than an
    /// already-resolved id — i.e. the two Mac surfaces. Resolving inside this
    /// type is the point: a surface that resolved the project itself could
    /// resolve it differently from the gate it renders.
    @MainActor
    static func attach(_ engine: ChatEngine, config: AppConfig, projectStore: ProjectStore) {
        attach(engine, toProject: resolve(config: config, projectStore: projectStore)?.projectId)
    }

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

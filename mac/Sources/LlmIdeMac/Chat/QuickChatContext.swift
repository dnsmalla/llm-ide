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
    ///
    /// The `nil` branch used to say "try again in a moment", which was a
    /// promise nothing kept: with `backendAutoStart` off — the flow
    /// `CLAUDE.md` documents — `start()` never ran, nothing else recorded a
    /// version, and "in a moment" never arrived. It now names the action that
    /// actually clears it. The re-check it mentions is real on every surface:
    /// the two Mac surfaces poll `refreshServerApiVersion()` while this text
    /// is on screen (`pollServerVersionWhileUnsupported`), and the phone
    /// probes once per question before declining.
    static func unsupportedServerMessage(apiVersion: Int?) -> String {
        guard let apiVersion else {
            return "This chat needs the LLM-IDE server's API v\(requiredServerApiVersion) or "
                + "newer, and no running server has reported its version. Start it — Settings → "
                + "Backend → Start, or run `node server.mjs` yourself if you start the server "
                + "from a terminal. This clears itself once the server answers."
        }
        return "Restart the LLM-IDE server to use this chat — it needs API "
            + "v\(requiredServerApiVersion) and the running server is v\(apiVersion)."
    }

    /// How long the Mac surfaces wait between `/health` re-probes while they
    /// are showing `unsupportedServerMessage`. Long enough to be free (a
    /// loopback GET with a 2 s budget), short enough that starting the server
    /// in a terminal opens the chat without touching the app.
    static let closedStateReprobeIntervalNanos: UInt64 = 5_000_000_000

    /// Re-probe the server's `apiVersion` for as long as the caller's task
    /// lives, stopping as soon as the gate can open.
    ///
    /// Attached with `.task` to the CLOSED-state view on both Mac surfaces,
    /// so it starts when that text appears and is cancelled when it goes
    /// away. Without it, `serverApiVersion` only ever changed inside
    /// `BackendManager.start()`/`stop()`, so a user who starts the server
    /// from a terminal (autostart off) had no way to reach this chat at all
    /// short of relaunching the app.
    @MainActor
    static func pollServerVersionWhileUnsupported(backend: BackendManager) async {
        while !Task.isCancelled {
            await backend.refreshServerApiVersion()
            if serverSupportsAsk(backend.serverApiVersion) { return }
            try? await Task.sleep(nanoseconds: closedStateReprobeIntervalNanos)
        }
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
    ///
    /// `refreshSessionListIfUnchanged` is the Mac surfaces' `.onAppear`
    /// behaviour (re-read the session list on every open). The phone attaches
    /// on EVERY request — each question, history fetch and clear — and has no
    /// session list to show, so it passes `false` and skips that disk read.
    @MainActor
    static func attach(
        _ engine: ChatEngine,
        toProject projectId: String?,
        refreshSessionListIfUnchanged: Bool = true
    ) {
        assert(engine.scope == .quick, "QuickChatContext.attach is for the .quick engine only")
        if engine.currentSessionIDString.isEmpty {
            engine.quickChatProjectId = projectId
            engine.handleOnAppearSessionsIfReady()
        } else if engine.quickChatProjectId != projectId {
            engine.switchQuickChatProject(to: projectId)
        } else if refreshSessionListIfUnchanged {
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

import AppKit
import Combine
import Foundation
import Observation
import SharedProtocol
import SystemConfiguration

/// One log line emitted by the mobile control subsystem.
struct MobileLogLine: Identifiable, Hashable {
    let id = UUID()
    let text: String
    let stream: Stream
    enum Stream: String { case stdout, stderr, info }
}

/// Owns the native mobile control server. Replaces the previous design that
/// spawned an external Node computer-agent (`npm start` on :3006): the Mac app
/// now runs the WebSocket server (`MobileWebSocketServer`), advertises it over
/// Bonjour (`MobileBonjourAdvertiser`), and mints the pairing PIN
/// (`MobilePin`) itself — no child process, no adopt-vs-spawn probing.
///
/// The observable surface (`status`, `logLines`, `lastError`, `Status` enum,
/// `clearLog()`) is unchanged so `LlmIdeMacApp` and
/// `MobileControlSettingsSection` keep working as before; only the
/// `start(agentPath:)` / `stopIfOwned()` API collapsed to `start()` / `stop()`.
@MainActor
@Observable
final class MobileControlManager {

    /// Default TCP port the native server listens on. Kept as a concrete
    /// constant so `MobileConnectionInfo.current(port:)` can default to it
    /// without depending on `SharedProtocol` directly.
    nonisolated static let defaultAgentPort = MobileProtocol.defaultPort

    enum Status: Equatable {
        case stopped
        case starting
        case running
        case crashed(exitCode: Int32)
    }

    private(set) var status: Status = .stopped
    private(set) var logLines: [MobileLogLine] = []
    var lastError: String?

    /// Set by the app at launch; used to proxy chat to the :3456 backend.
    var api: LlmIdeAPIClient?

    /// Set by the app at launch; backing state for `auto_task_list` replies.
    /// Both are optional so this manager can still be constructed in previews
    /// / tests without the full Auto Task stack.
    var autoCode: AutoCodeUpdateService?
    /// Set by the app at launch; the single source of truth for master +
    /// per-task enables, mutated by `auto_task_toggle`.
    var autoTaskSettings: AutoTaskSettings?
    /// Mac Settings + workspace — used to run iPhone explore prompts with the
    /// same model/provider and agent context as the desktop Explorer panel.
    var config: AppConfig?
    var projectStore: ProjectStore?
    /// Local Node backend supervisor — used for `mac_status` snapshots.
    var backendManager: BackendManager?

    /// Persisted `@file` / `/skill` browse indexes under Application Support settings/.
    let exploreIndex = MobileExploreIndexStore()

    private var server: MobileWebSocketServer?
    private var advertiser: MobileBonjourAdvertiser?
    private var workspaceWatcher: RepoFileWatcher?
    private var sessionDirectoryWatcher: RepoFileWatcher?
    private let maxLogLines = 5_000

    /// True after a client completes PIN pairing; cleared on disconnect.
    private var mobileClientPaired = false
    private var mobilePushCancellables = Set<AnyCancellable>()
    private var mobileInflightTasks: [String: Task<Void, Never>] = [:]
    /// Commands the iPhone cancelled — late HTTP replies must not persist or stream.
    private var mobileCancelledCommandIds = Set<String>()

    /// Shared decoder reused across every `handleInbound` case. `JSONDecoder`
    /// is thread-safe for independent `decode(_:)` calls and this manager is
    /// `@MainActor`, so reusing one instance avoids the per-case allocation
    /// (previously ~7 fresh decoders per inbound dispatch).
    private let decoder = JSONDecoder()

    init() {
        // Best-effort teardown of the native server on force-quit / Cmd-Q /
        // logout so the listener + Bonjour service don't briefly outlive the
        // app. `stop()` is idempotent and main-isolated like this hook.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.stop()
            }
        }
    }

    // MARK: - Start / stop

    func start() {
        if case .running = status { return }
        if case .starting = status { return }

        status = .starting

        guard let pin = (try? MobilePin.ensure()) ?? MobilePin.read() else {
            lastError = "Couldn't read or create the mobile pairing PIN in Keychain. Quit and relaunch LLM-IDE, then try Start again."
            append(.stderr, "ERROR: mobile pairing PIN unavailable in Keychain")
            status = .crashed(exitCode: -1)
            return
        }

        let name = Self.deviceName()
        let server = MobileWebSocketServer(
            port: MobileProtocol.defaultPort,
            deviceName: name,
            validatePin: { candidate in
                // The PIN is always 6 digits (`%06d`), but a user typing on a
                // phone number pad often omits leading zeros (e.g. "42" for
                // "000042"). Left-zero-pad an all-ASCII-digit candidate of
                // ≤6 chars before comparing so that omission still matches,
                // without weakening the check for any other input.
                let isAllDigits = !candidate.isEmpty
                    && candidate.allSatisfy { ("0"..."9").contains($0) }
                let normalized = (candidate.count <= 6 && isAllDigits)
                    ? String(repeating: "0", count: 6 - candidate.count) + candidate
                    : candidate
                return normalized == pin
            },
            onInbound: { [weak self] data in Task { @MainActor in self?.handleInbound(data) } },
            onLog: { [weak self] line in
                Task { @MainActor [weak self] in self?.append(.info, line) }
            },
            onClientPaired: { [weak self] in
                Task { @MainActor [weak self] in self?.onMobileClientPaired() }
            },
            onClientDisconnected: { [weak self] in
                Task { @MainActor [weak self] in self?.onMobileClientDisconnected() }
            }
        )
        do {
            try server.start()
        } catch {
            // Actionable message for the common case — port :3006 already bound.
            lastError = "Couldn't start the mobile server on port \(MobileProtocol.defaultPort) — another process may already be using it. Run `lsof -i :3006`, quit the other process, then press Start again. (\(error.localizedDescription))"
            append(.stderr, "ERROR: \(error.localizedDescription)")
            status = .crashed(exitCode: -1)
            return
        }
        self.server = server

        let advertiser = MobileBonjourAdvertiser(name: name, port: MobileProtocol.defaultPort)
        advertiser.start()
        self.advertiser = advertiser

        status = .running
        startWorkspaceWatcher()
        startSessionDirectoryWatcher()
        exploreIndex.bootstrapFromDisk()
        refreshExploreIndexes(force: false)
        installMobilePushObservers()
    }

    /// Rebuild workspace + skill JSON indexes when the project changes or the
    /// user presses Refresh in Mobile Control settings.
    func refreshExploreIndexes(force: Bool) {
        Task {
            await exploreIndex.refreshAll(
                workspaceRoot: mobileWorkspaceURL(),
                api: api,
                force: force
            )
            if force {
                let trunc = exploreIndex.workspaceTruncated ? " (workspace truncated)" : ""
                append(.info, "Mobile explore indexes refreshed — workspace: \(exploreIndex.workspaceEntryCount), skills: \(exploreIndex.skillsEntryCount)\(trunc)")
            }
        }
    }

    func onWorkspaceChanged() {
        exploreIndex.invalidateWorkspaceIndex()
        startWorkspaceWatcher()
        refreshExploreIndexes(force: false)
    }

    /// Rebuild the skills index once the Node backend is healthy (catalog API).
    func onBackendReady() {
        exploreIndex.invalidateSkillsIndex()
        Task {
            if let api {
                await exploreIndex.refreshSkillsIndex(api: api, force: true)
            }
        }
    }

    private func startWorkspaceWatcher() {
        workspaceWatcher?.stop()
        workspaceWatcher = nil
        guard case .running = status, let root = mobileWorkspaceURL() else { return }
        workspaceWatcher = RepoFileWatcher(repoRoot: root, debounce: 3.0) { [weak self] in
            Task { @MainActor in self?.onWorkspaceFilesChanged() }
        }
    }

    private func onWorkspaceFilesChanged() {
        guard case .running = status, let root = mobileWorkspaceURL() else { return }
        Task {
            await exploreIndex.refreshWorkspaceIndex(root: root, force: true)
            append(.info, "Workspace index updated after file change (\(exploreIndex.workspaceEntryCount) entries)")
        }
    }

    /// Tear down the native server and Bonjour advertisement. Idempotent —
    /// safe to call from the Quit hook, the Stop button, or a failed restart.
    func stop() {
        workspaceWatcher?.stop()
        workspaceWatcher = nil
        sessionDirectoryWatcher?.stop()
        sessionDirectoryWatcher = nil
        mobilePushCancellables.removeAll()
        onMobileClientDisconnected()
        server?.stop()
        server = nil
        advertiser?.stop()
        advertiser = nil
        status = .stopped
    }

    func clearLog() {
        logLines.removeAll(keepingCapacity: true)
    }

    // MARK: - Inbound + logging

    /// Dispatch decoded inbound client messages by `type` discriminator.
    ///
    /// Decodes a one-field `{type}` envelope ONCE, then routes to a per-feature
    /// handler. The SharedProtocol structs use `let type = "…"` with a
    /// synthesized `init(from:)` that does NOT validate the discriminator
    /// value, and several explorer structs (`ExploreListSessions`/
    /// `ExploreNewSession`) are empty — so a greedy sequential `decode` would
    /// let the first empty struct swallow every payload. The envelope +
    /// `switch`-on-prefix keeps each full message type reachable and splits the
    /// three feature channels into their own methods: the `llmide_chat` arm
    /// stays inline (a single decode + `handleChat`); `explore_*` →
    /// `handleExplore(type:data:)`; `auto_task_*` →
    /// `handleAutoTask(type:data:)`. Tag strings come from the single source of
    /// truth in `MobileProtocol.Tag`. Unknown prefixes log and drop.
    /// Each case body is byte-identical to the previous monolithic switch.
    private func handleInbound(_ data: Data) {
        struct Envelope: Decodable { let type: String }
        guard let env = try? decoder.decode(Envelope.self, from: data) else {
            let preview = String(data: data, encoding: .utf8) ?? "<\(data.count) bytes>"
            append(.info, "Unhandled inbound (no type): \(preview)")
            return
        }

        switch env.type {
        case MobileProtocol.Tag.llmIdeChat:
            // Phase 3/4 chat proxy — must keep working alongside explorer ops.
            if let chat = try? decoder.decode(LlmIdeChat.self, from: data) {
                append(.info, "Chat: \(chat.text.prefix(40))")
                registerMobileInflightTask(commandId: chat.commandId) {
                    await self.handleChat(chat)
                }
            }
        case MobileProtocol.Tag.llmIdeCancel:
            handleLlmIdeCancel(data: data)
        case MobileProtocol.Tag.macStatusList:
            Task { await handleMacStatusList() }
        case let t where t.hasPrefix("explore_"):
            handleExplore(type: t, data: data)
        case let t where t.hasPrefix("auto_task_"):
            handleAutoTask(type: t, data: data)
        default:
            append(.info, "Unhandled inbound type: \(env.type)")
        }
    }

    /// Handle `explore_*` messages: list / load / new / delete / chat for the
    /// Mac-local explorer-chat sessions (`ChatSessionStore`, scope `.explorer`).
    /// Each case is the pre-existing body moved verbatim from the old
    /// monolithic `handleInbound` switch; the shared `decoder`, `reply(_:)`,
    /// and `append(_:_:)` helpers are unchanged. Mirrors the iOS receive loop.
    private func handleExplore(type: String, data: Data) {
        switch type {
        case MobileProtocol.Tag.exploreListSessions:
            // `ChatSessionStore` is Mac-local JSON keyed by `ChatScope.explorer`.
            let rows = ChatSessionStore.list(for: .explorer).map {
                ExploreSessionSummary(id: $0.id.uuidString,
                                      title: $0.title,
                                      lastUsedAt: $0.lastUsedAt.timeIntervalSince1970)
            }
            append(.info, "Explore list: \(rows.count) session(s)")
            reply(ExploreSessionList(sessions: rows))
        case MobileProtocol.Tag.exploreLoadSession:
            guard let m = try? decoder.decode(ExploreLoadSession.self, from: data) else {
                append(.info, "Explore load: undecodable payload")
                reply(CommandError(commandId: "explore_load", message: "Invalid load-session request"))
                return
            }
            guard let sid = UUID(uuidString: m.sessionId) else {
                append(.info, "Explore load: bad session id \"\(m.sessionId.prefix(8))\"")
                reply(CommandError(commandId: "explore_load", message: "Invalid session id"))
                return
            }
            guard let s = ChatSessionStore.load(id: sid) else {
                append(.info, "Explore load: session \(sid.uuidString.prefix(8)) not found")
                reply(CommandError(commandId: "explore_load",
                                   message: "Session not found on Mac — it may have been deleted."))
                return
            }
            let turns = s.history.map { ChatTurn(from: $0) }
            append(.info, "Explore load: \(s.id.uuidString.prefix(8))")
            reply(ExploreSessionHistory(sessionId: s.id.uuidString,
                                        title: s.title,
                                        history: turns))
        case MobileProtocol.Tag.exploreNewSession:
            let s = ChatSession(scope: .explorer, title: "New chat")
            ChatSessionStore.save(s)
            append(.info, "Explore new: \(s.id.uuidString.prefix(8))")
            reply(ExploreSessionCreated(sessionId: s.id.uuidString))
        case MobileProtocol.Tag.exploreDeleteSession:
            if let m = try? decoder.decode(ExploreDeleteSession.self, from: data) {
                if let uid = UUID(uuidString: m.sessionId) {
                    ChatSessionStore.delete(id: uid)
                    append(.info, "Explore delete: \(uid.uuidString.prefix(8))")
                }
            }
        case MobileProtocol.Tag.exploreChat:
            if let chat = try? decoder.decode(ExploreChat.self, from: data) {
                append(.info, "Explore chat in \(chat.sessionId.prefix(8))")
                registerMobileInflightTask(commandId: chat.commandId) {
                    await self.handleExploreChat(chat)
                }
            }
        case MobileProtocol.Tag.exploreCancel:
            handleExploreCancel(data: data)
        case MobileProtocol.Tag.exploreRenameSession:
            handleExploreRenameSession(data: data)
        case MobileProtocol.Tag.exploreSearchFiles:
            if let req = try? decoder.decode(ExploreSearchFiles.self, from: data) {
                handleExploreSearch(req)
            }
        case MobileProtocol.Tag.exploreSearchSkills:
            if let req = try? decoder.decode(ExploreSearchSkills.self, from: data) {
                Task { await handleExploreSearchSkills(req) }
            }
        default:
            append(.info, "Unhandled explore type: \(type)")
        }
    }

    /// Find files/folders on the Mac workspace by name (for iPhone @file picker).
    private func handleExploreSearch(_ req: ExploreSearchFiles) {
        guard let root = mobileWorkspaceURL() else {
            reply(ExploreSearchReply(workspaceRoot: nil, matches: [],
                                   error: "No Mac workspace open — open a project in LLM-IDE on your Mac."))
            return
        }
        Task {
            let limit = min(max(req.limit ?? MobileWorkspaceSearch.defaultLimit, 1), 80)
            let matches = await exploreIndex.searchWorkspace(
                query: req.query, workspaceRoot: root, limit: limit)
            let rootLabel = MobileExploreBridge.homeRelativePathForDisplay(root.path)
            append(.info, "Explore search \"\(req.query.prefix(40))\" → \(matches.count) hit(s) [index]")
            reply(ExploreSearchReply(workspaceRoot: rootLabel, matches: matches, error: nil))
        }
    }

    /// Find agent skills on the Mac (library + built-in) for iPhone `/skill` picker.
    private func handleExploreSearchSkills(_ req: ExploreSearchSkills) async {
        guard let api else {
            reply(ExploreSkillListReply(matches: [],
                                        error: "Backend not configured — start LLM-IDE server on your Mac."))
            return
        }
        let limit = min(max(req.limit ?? MobileSkillCatalog.defaultLimit, 1), 80)
        let matches = await exploreIndex.searchSkills(query: req.query, api: api, limit: limit)
        append(.info, "Explore skill search \"\(req.query.prefix(40))\" → \(matches.count) hit(s) [index]")
        reply(ExploreSkillListReply(matches: matches, error: nil))
    }

    /// Active explorer code root — same precedence as `ExplorerView.root`.
    private func mobileWorkspaceURL() -> URL? {
        guard let config, let projectStore else { return nil }
        if let code = projectStore.activeProjectCodeDir { return code }
        return WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }

    /// Handle `auto_task_*` messages: list / toggle / run / stop / history for
    /// the Auto Task scheduler. Each case is the pre-existing body moved
    /// verbatim from the old monolithic `handleInbound` switch; the
    /// `autoCode`/`autoTaskSettings` deps are @MainActor like this manager.
    /// `replyNotConfigured(commandId:logLabel:)` mirrors a `CommandError` when
    /// the wiring is absent so the phone shows a concrete reason.
    private func handleAutoTask(type: String, data: Data) {
        switch type {
        case MobileProtocol.Tag.autoTaskList:
            // Snapshot the current Auto Task scheduler + per-task state. Both
            // deps are @MainActor like this manager, so the reads below are
            // isolation-safe. Missing wiring → a CommandError so the phone
            // shows a concrete reason instead of an unanswered request.
            guard let state = buildAutoTaskState() else {
                replyNotConfigured(commandId: "auto_task", logLabel: "auto_task_list")
                return
            }
            append(.info, "Auto-task state: \(state.isRunning ? "running" : "idle"), master=\(state.masterEnabled)")
            reply(state)
        case MobileProtocol.Tag.autoTaskToggle:
            // Flip the master enable (task == nil) or a single per-task flag.
            // Routes through AutoTaskSettings.setEnabled / .enabled so the
            // @Published didSet persists + arms/disarms the scheduler exactly
            // as the on-Mac Settings toggle would.
            if let m = try? decoder.decode(AutoTaskToggle.self, from: data) {
                if let taskName = m.task, let t = AutoTask(rawValue: taskName) {
                    autoTaskSettings?.setEnabled(m.enabled, task: t)
                    append(.info, "Auto-task toggle \(t.rawValue)=\(m.enabled)")
                } else {
                    autoTaskSettings?.enabled = m.enabled
                    append(.info, "Auto-task master=\(m.enabled)")
                }
                replyAutoTaskStateOrAck()
            }
        case MobileProtocol.Tag.autoTaskRun:
            // Trigger a global run (task == nil) or a single per-task manual
            // run. `runNow()`/`runSingle(_:)` are @MainActor-sync — each spins
            // its own internal `Task` — so no await is needed; we're already
            // on the main actor here (handleInbound is main-isolated).
            guard let ac = autoCode else {
                replyNotConfigured(commandId: "auto_task_run", logLabel: "auto_task_run")
                return
            }
            if let m = try? decoder.decode(AutoTaskRun.self, from: data) {
                if let raw = m.task, let t = AutoTask(rawValue: raw) {
                    ac.runSingle(t)
                    append(.info, "Auto-task run single: \(t.rawValue)")
                } else {
                    ac.runNow()
                    append(.info, "Auto-task run now")
                }
                replyAutoTaskStateOrAck()
            }
        case MobileProtocol.Tag.autoTaskStop:
            // `cancel()` is @MainActor-sync: cancels the in-flight `runTask`
            // and terminates the active subprocess. No-op when idle; nil-safe
            // via `?` (no wiring → ack still replies, phone doesn't hang).
            autoCode?.cancel()
            append(.info, "Auto-task stop")
            replyAutoTaskStateOrAck()
        case MobileProtocol.Tag.autoTaskHistory:
            // Snapshot the processed-actions registry. `allEntries` is
            // @Published on AutoCodeUpdateService (a cached copy of
            // Registry.allEntries()), so the read is cheap and main-isolated.
            let entries = (autoCode?.allEntries ?? []).map {
                AutoTaskHistoryEntry(actionText: $0.actionText,
                                     status: $0.status.rawValue,
                                     lastUpdated: $0.lastUpdated.timeIntervalSince1970)
            }
            append(.info, "Auto-task history: \(entries.count) entries")
            reply(AutoTaskHistoryReply(entries: entries))
        default:
            append(.info, "Unhandled auto-task type: \(type)")
        }
    }

    /// Proxy an llm-ide chat turn through the backend agent. The reply is sent
    /// back as a nested `Output` payload (`{stream, done:true}`) so the iOS
    /// receive loop can treat it as a completed command; failures surface as a
    /// `CommandError` and are mirrored into the Mac log + `lastError`.
    private func handleChat(_ chat: LlmIdeChat) async {
        guard let api else {
            await server?.send(CommandError(commandId: chat.commandId, message: "Backend not configured"))
            return
        }
        let history = chat.history.map {
            LlmIdeAPIClient.AgentAskMessage(role: .init(rawValue: $0.role) ?? .user, content: $0.content)
        }
        let images = chat.images.map { (mediaType: $0.mediaType, data: $0.data) }
        // Fold extracted file text into the prompt (mirrors how history is folded server-side).
        let message = Self.messageWithFiles(chat.text, files: chat.files)
        do {
            let reply = try await api.askAgent(message: message, history: history, images: images)
            guard !isMobileCommandCancelled(chat.commandId) else { return }
            await server?.send(Output(commandId: chat.commandId,
                                      payload: OutputPayload(stream: reply, done: true)))
        } catch is CancellationError {
            append(.info, "llmide_chat cancelled: \(chat.commandId.prefix(8))")
        } catch {
            guard !isMobileCommandCancelled(chat.commandId) else { return }
            append(.stderr, "askAgent failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
            await server?.send(CommandError(commandId: chat.commandId, message: error.localizedDescription))
        }
    }

    /// Proxy an explorer chat turn through the backend Code Assistant and
    /// persist the appended history into the Mac's `ChatSessionStore`, so the
    /// phone and Mac stay in sync. The reply is sent back as a nested `Output`
    /// payload (`{stream, done:true}`); failures surface as a `CommandError`
    /// and are mirrored into the Mac log + `lastError`. Mirrors `handleChat`
    /// but routes through `codeAssistStream` (live agent progress) and writes
    /// the user + assistant turns back to the session file.
    private func handleExploreChat(_ chat: ExploreChat) async {
        guard let api else {
            await server?.send(CommandError(commandId: chat.commandId, message: "Backend not configured"))
            return
        }
        guard let sid = UUID(uuidString: chat.sessionId) else {
            await server?.send(CommandError(commandId: chat.commandId, message: "Bad session id"))
            return
        }
        // Upfront existence check: a stale sessionId (the session was deleted
        // on the Mac while the phone still holds an old id) would otherwise
        // stream a reply that the `if var session` block below silently drops
        // instead of persisting — Mac↔phone drift with no error. Surface it as
        // a CommandError so the phone can reload its explorer session list.
        // The re-check below stays as a race fallback (session deleted
        // mid-request, between this guard and the post-stream persist).
        guard ChatSessionStore.load(id: sid) != nil else {
            append(.info, "explore_chat: session \(chat.sessionId.prefix(8)) not found")
            await server?.send(CommandError(commandId: chat.commandId, message: "Session not found on Mac — it may have been deleted. Reload your explorer sessions."))
            return
        }
        let history = chat.history.map { LlmIdeAPIClient.CodeAssistTurn(from: $0) }
        var attachments = MobileExploreBridge.attachments(from: chat.files)
        if let root = mobileWorkspaceURL(), !chat.refs.isEmpty {
            let (refAttachments, refErrors) = MobileWorkspaceSearch.attachments(
                from: chat.refs, workspaceRoot: root)
            attachments.append(contentsOf: refAttachments)
            for err in refErrors { append(.info, "explore_chat: \(err)") }
        }
        let agentMessage = MobileWorkspaceSearch.promptWithRefs(chat.text, refs: chat.refs)
        let (skillMessage, skillIds) = MobileSkillCatalog.resolveMessage(agentMessage, skills: chat.skills)
        let (model, provider) = config.map { MobileExploreBridge.modelAndProvider(config: $0) }
            ?? (nil as String?, nil as String?)
        let agentContext: AgentContext?
        if let config, let projectStore {
            agentContext = await MobileExploreBridge.buildAgentContext(
                config: config, projectStore: projectStore, sessionId: chat.sessionId)
        } else {
            agentContext = nil
            if !chat.files.isEmpty || !chat.refs.isEmpty {
                append(.info, "explore_chat: Mac workspace not wired — attachments/refs may be limited")
            }
        }
        do {
            let commandId = chat.commandId
            let resp = try await api.codeAssistStream(
                message: skillMessage,
                language: nil,
                model: model,
                provider: provider,
                history: history,
                attachments: attachments,
                skills: skillIds,
                agentContext: agentContext,
                onProgress: { [weak self] label in
                    guard let self, !self.isMobileCommandCancelled(commandId) else { return }
                    append(.info, "code-assist: \(label)")
                    Task {
                        guard !self.isMobileCommandCancelled(commandId) else { return }
                        await self.server?.send(Output(
                            commandId: commandId,
                            payload: OutputPayload(stream: label, done: false)))
                    }
                }
            )
            guard !isMobileCommandCancelled(chat.commandId) else { return }
            // Persist user + assistant turns into the Mac session (keeps phone
            // & Mac in sync). The upfront guard above already rejected stale
            // sessions; this re-load is a race fallback for the window between
            // that guard and now (session deleted mid-stream) — if it hits,
            // the reply still streams but the turn is dropped on purpose.
            if var session = ChatSessionStore.load(id: sid) {
                session.history.append(LlmIdeAPIClient.CodeAssistTurn(role: .user, content: skillMessage))
                session.history.append(LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: resp.reply))
                if session.title == "New chat" { session.title = String(chat.text.prefix(40)) }
                ChatSessionStore.save(session)
            }
            await server?.send(Output(commandId: chat.commandId,
                                      payload: OutputPayload(stream: resp.reply, done: true)))
        } catch is CancellationError {
            append(.info, "explore_chat cancelled: \(chat.commandId.prefix(8))")
        } catch {
            guard !isMobileCommandCancelled(chat.commandId) else { return }
            append(.stderr, "code-assist failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
            await server?.send(CommandError(commandId: chat.commandId, message: error.localizedDescription))
        }
    }

    /// Prepend each extracted file's text as a fenced block before the user's
    /// message, so the agent sees the file contents as context. Empty when no
    /// files were attached (returns the text unchanged).
    private static func messageWithFiles(_ text: String, files: [ChatFileText]) -> String {
        guard !files.isEmpty else { return text }
        let blocks = files.map { "--- File: \($0.name) ---\n\($0.text)" }.joined(separator: "\n\n")
        return "\(blocks)\n\n\(text)"
    }

    /// The user-facing Mac name, used as both the WebSocket device name and the
    /// Bonjour service name. Falls back to the hostname if the SystemConfig
    /// lookup fails (e.g. headless-ish environments).
    private static func deviceName() -> String {
        if let name = SCDynamicStoreCopyComputerName(nil, nil) as String? {
            return name
        }
        return ProcessInfo.processInfo.hostName
    }

    private func append(_ stream: MobileLogLine.Stream, _ text: String) {
        logLines.append(.init(text: text, stream: stream))
        if logLines.count > maxLogLines {
            logLines.removeFirst(logLines.count - maxLogLines)
        }
    }

    // MARK: - Reply helpers

    /// Fire-and-forget encode + send to the active client. Collapses the
    /// `Task { await server?.send(...) }` pattern that previously peppered
    /// `handleInbound` (a non-async context). Sites already inside an `async`
    /// function (`handleChat`/`handleExploreChat`) call `await server?.send`
    /// directly — this helper would only double-wrap them in a stray `Task`.
    private func reply(_ message: some Encodable) {
        Task { await server?.send(message) }
    }

    /// Auto-tasks dependency (`autoCode`/`autoTaskSettings`) isn't wired —
    /// mirror a `CommandError` to the client and a stderr line to the Mac log.
    /// `commandId` is the wire discriminator the phone keys on; `logLabel` is
    /// the (separately observable) prefix shown in the Mac log, kept distinct
    /// to preserve the original "auto_task_list"/"auto_task_run" wording.
    private func replyNotConfigured(commandId: String, logLabel: String) {
        append(.stderr, "\(logLabel): Auto-tasks not configured")
        reply(CommandError(commandId: commandId, message: "Auto-tasks not configured"))
    }

    /// Build the wire snapshot the iPhone mirrors. Returns nil when the Auto
    /// Task stack isn't wired (previews / tests).
    private func buildAutoTaskState() -> AutoTaskState? {
        guard let ac = autoCode, let s = autoTaskSettings else { return nil }
        let infos = AutoTask.allCases.map { t in
            AutoTaskInfo(id: t.rawValue, label: t.label,
                         enabled: s.isEnabled(task: t),
                         lastError: ac.taskErrors[t.rawValue])
        }
        return AutoTaskState(masterEnabled: s.enabled,
                             isRunning: ac.isRunning,
                             currentTask: ac.currentTask?.rawValue,
                             currentStep: ac.currentStep,
                             statusMessage: ac.statusMessage,
                             lastRunDate: ac.lastRunDate?.timeIntervalSince1970,
                             createdCount: ac.createdCount,
                             implementedCount: ac.implementedCount,
                             failedCount: ac.failedCount,
                             tasks: infos)
    }

    /// After run/stop/toggle the phone needs a fresh snapshot — not just a bare
    /// ack — so execution status mirrors the Mac without a manual refresh.
    private func replyAutoTaskStateOrAck() {
        if let state = buildAutoTaskState() {
            reply(state)
        } else {
            reply(AutoTaskAck(ok: true, message: nil))
        }
    }

    // MARK: - Phase A: mobile push sync, cancel, status, rename

    /// Subscribe to Mac-side Auto Task + explorer session changes and push
    /// snapshots to a paired iPhone without waiting for a pull request.
    func installMobilePushObservers() {
        mobilePushCancellables.removeAll()
        guard let ac = autoCode else { return }

        ac.objectWillChange
            .debounce(for: .milliseconds(350), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.pushAutoTaskStateIfPaired() }
            .store(in: &mobilePushCancellables)

        autoTaskSettings?.objectWillChange
            .debounce(for: .milliseconds(350), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.pushAutoTaskStateIfPaired() }
            .store(in: &mobilePushCancellables)

        projectStore?.objectWillChange
            .debounce(for: .milliseconds(350), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                Task { await self?.pushMacStatusIfPaired() }
            }
            .store(in: &mobilePushCancellables)
    }

    /// Push a fresh Mac status snapshot when backend or project context changes.
    func onMacEnvironmentChanged() {
        Task { await pushMacStatusIfPaired() }
    }

    private func onMobileClientPaired() {
        mobileClientPaired = true
        pushAutoTaskStateIfPaired()
        pushExploreSessionListIfPaired()
        Task { await pushMacStatusIfPaired() }
    }

    private func onMobileClientDisconnected() {
        mobileClientPaired = false
        mobileCancelledCommandIds.removeAll()
        for task in mobileInflightTasks.values { task.cancel() }
        mobileInflightTasks.removeAll()
    }

    private func pushAutoTaskStateIfPaired() {
        guard mobileClientPaired, let state = buildAutoTaskState() else { return }
        reply(state)
    }

    private func pushExploreSessionListIfPaired() {
        guard mobileClientPaired else { return }
        let rows = ChatSessionStore.list(for: .explorer).map {
            ExploreSessionSummary(id: $0.id.uuidString,
                                  title: $0.title,
                                  lastUsedAt: $0.lastUsedAt.timeIntervalSince1970)
        }
        reply(ExploreSessionList(sessions: rows))
    }

    private func pushMacStatusIfPaired() async {
        guard mobileClientPaired else { return }
        if let status = await buildMacStatus() {
            await server?.send(status)
        }
    }

    private func startSessionDirectoryWatcher() {
        sessionDirectoryWatcher?.stop()
        sessionDirectoryWatcher = nil
        guard case .running = status,
              let dir = ChatSessionStore.explorerSessionsDirectory else { return }
        sessionDirectoryWatcher = RepoFileWatcher(repoRoot: dir, debounce: 1.0) { [weak self] in
            Task { @MainActor in self?.pushExploreSessionListIfPaired() }
        }
    }

    private func registerMobileInflightTask(commandId: String,
                                          operation: @escaping () async -> Void) {
        mobileInflightTasks[commandId]?.cancel()
        mobileCancelledCommandIds.remove(commandId)
        mobileInflightTasks[commandId] = Task {
            defer { mobileInflightTasks.removeValue(forKey: commandId) }
            await operation()
        }
    }

    private func cancelMobileInflightTask(commandId: String) {
        mobileCancelledCommandIds.insert(commandId)
        mobileInflightTasks[commandId]?.cancel()
        mobileInflightTasks.removeValue(forKey: commandId)
        reply(CommandError(commandId: commandId, message: "Cancelled"))
    }

    private func isMobileCommandCancelled(_ commandId: String) -> Bool {
        mobileCancelledCommandIds.contains(commandId)
    }

    private func handleLlmIdeCancel(data: Data) {
        guard let m = try? decoder.decode(LlmIdeCancel.self, from: data) else { return }
        append(.info, "llmide_cancel \(m.commandId.prefix(8))")
        cancelMobileInflightTask(commandId: m.commandId)
    }

    private func handleExploreCancel(data: Data) {
        guard let m = try? decoder.decode(ExploreCancel.self, from: data) else { return }
        append(.info, "explore_cancel \(m.commandId.prefix(8))")
        cancelMobileInflightTask(commandId: m.commandId)
    }

    private func handleExploreRenameSession(data: Data) {
        guard let m = try? decoder.decode(ExploreRenameSession.self, from: data),
              let sid = UUID(uuidString: m.sessionId),
              var session = ChatSessionStore.load(id: sid),
              session.scope == .explorer else {
            reply(CommandError(commandId: "explore_rename", message: "Session not found on Mac"))
            return
        }
        let trimmed = m.title.trimmingCharacters(in: .whitespacesAndNewlines)
        session.title = trimmed.isEmpty ? "Untitled" : trimmed
        ChatSessionStore.save(session)
        append(.info, "Explore rename: \(sid.uuidString.prefix(8)) → \(session.title.prefix(30))")
        reply(ExploreSessionRenamed(sessionId: sid.uuidString, title: session.title))
        pushExploreSessionListIfPaired()
    }

    private func handleMacStatusList() async {
        if let status = await buildMacStatus() {
            await server?.send(status)
        } else {
            reply(CommandError(commandId: "mac_status", message: "Mac status unavailable"))
        }
    }

    private func buildMacStatus() async -> MacStatus? {
        let projectName = projectStore?.activeProject?.bundle.displayName
        var gitBranch: String?
        var workspacePath: String?
        if let config, let projectStore {
            let ctx = await MobileExploreBridge.buildAgentContext(
                config: config, projectStore: projectStore, sessionId: nil)
            gitBranch = ctx.currentBranch
            workspacePath = ctx.workspaceRoot
        }
        let backendUp = await BackendManager.probeHealth()
        let mobileControlUp: Bool = {
            if case .running = status { return true }
            return false
        }()
        return MacStatus(projectName: projectName,
                         gitBranch: gitBranch,
                         workspacePath: workspacePath,
                         backendUp: backendUp,
                         mobileControlUp: mobileControlUp)
    }
}

// MARK: - ChatTurn ↔ CodeAssistTurn mapping

/// The SharedProtocol `ChatTurn` (wire shape) and the Mac-side
/// `LlmIdeAPIClient.CodeAssistTurn` (Code Assistant view-model) carry the same
/// `{role, content}` payload but differ in the `id`/role-enum representation.
/// Both conversion directions live here so the mapping can't drift between the
/// `explore_load_session` (→) and `handleExploreChat` (←) paths. Defined in
/// the Mac target (not SharedProtocol) because `CodeAssistTurn` is Mac-local
/// and a SharedProtocol-side dependency would be circular.
extension ChatTurn {
    /// Code Assistant view-model → SharedProtocol wire shape: drop the
    /// client-only `id`, surface the role as its raw string ("user"/"assistant").
    init(from t: LlmIdeAPIClient.CodeAssistTurn) {
        self.init(role: t.role.rawValue, content: t.content)
    }
}

extension LlmIdeAPIClient.CodeAssistTurn {
    /// SharedProtocol wire shape → Code Assistant view-model. Unknown roles
    /// fall back to `.user` (matches the prior inline behavior).
    init(from t: ChatTurn) {
        self.init(role: .init(rawValue: t.role) ?? .user, content: t.content)
    }
}

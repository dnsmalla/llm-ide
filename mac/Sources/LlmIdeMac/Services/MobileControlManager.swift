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

    /// UserDefaults key for the user-configured base port (Settings →
    /// Mobile Control → Port).
    nonisolated static let portDefaultsKey = "mobileControl.basePort"

    /// The port the user configured, defaulting to `defaultAgentPort`. Only
    /// non-privileged, in-range values are honoured — anything else (unset,
    /// 0, a typo like 99999) falls back to the default rather than producing
    /// a listener that can never bind. The port number carries no security
    /// weight (pairing is PIN + token gated); configurability exists to
    /// dodge conflicts with whatever else a dev machine runs.
    nonisolated static var configuredPort: Int {
        get {
            let stored = UserDefaults.standard.integer(forKey: portDefaultsKey)
            return (1024...65535).contains(stored) ? stored : defaultAgentPort
        }
        set {
            if (1024...65535).contains(newValue), newValue != defaultAgentPort {
                UserDefaults.standard.set(newValue, forKey: portDefaultsKey)
            } else {
                // The default (or an invalid value) is represented by absence,
                // so a later change to `defaultAgentPort` follows automatically.
                UserDefaults.standard.removeObject(forKey: portDefaultsKey)
            }
        }
    }

    enum Status: Equatable {
        case stopped
        case starting
        case running
        case crashed(exitCode: Int32)
    }

    private(set) var status: Status = .stopped
    /// The port the listener ACTUALLY bound — the configured port, or a
    /// fallback candidate when that was busy. Nil while not listening.
    /// Everything user-facing (Bonjour, the pairing QR, the settings Port
    /// row) reads this, never the configured value.
    private(set) var activePort: Int?
    private(set) var logLines: [MobileLogLine] = []
    var lastError: String?

    /// Set by the app at launch; used to proxy chat to the :3456 backend.
    var api: LlmIdeAPIClient?

    /// Feature bridge for `auto_task_*` messages — nil when Auto Tasks is
    /// compiled out or not yet wired (see `routeToFeatureBridge`).
    var autoTaskBridge: MobileFeatureBridge?
    /// Feature bridge for `loop_*` messages — nil when Loop is compiled out
    /// or not yet wired (see `routeToFeatureBridge`).
    var loopBridge: MobileFeatureBridge?
    /// Mac Settings + workspace — used to run iPhone explore prompts with the
    /// same model/provider and agent context as the desktop Explorer panel.
    var config: AppConfig?
    var projectStore: ProjectStore?
    /// Local Node backend supervisor — used for `mac_status` snapshots.
    var backendManager: BackendManager?

    /// Persisted `@file` / `/skill` browse indexes under Application Support settings/.
    let exploreIndex = MobileExploreIndexStore()

    /// Resolves which `.explorer` `ChatEngine` `handleExploreChat` drives a
    /// turn on — the shared, Mac-panel-visible one when safe, or a private
    /// off-screen engine when the Mac is already showing a different session
    /// (see that type's doc comment for why this exists).
    private let explorerMobileEngineResolver = ExplorerMobileEngineResolver()

    private var server: MobileWebSocketServer?
    private var advertiser: MobileBonjourAdvertiser?
    private var workspaceWatcher: RepoFileWatcher?
    private var sessionDirectoryWatcher: RepoFileWatcher?
    private let maxLogLines = 5_000

    /// True after a client completes PIN pairing; cleared on disconnect.
    // internal: shared with the Mobile*Bridge classes (feature folders)
    var mobileClientPaired = false
    private var mobilePushCancellables = Set<AnyCancellable>()
    private var mobileInflightTasks: [String: Task<Void, Never>] = [:]
    /// Commands the iPhone cancelled — late HTTP replies must not persist or stream.
    private var mobileCancelledCommandIds = Set<String>()

    /// Shared decoder reused across every `handleInbound` case. `JSONDecoder`
    /// is thread-safe for independent `decode(_:)` calls and this manager is
    /// `@MainActor`, so reusing one instance avoids the per-case allocation
    /// (previously ~7 fresh decoders per inbound dispatch).
    // internal: shared with the Mobile*Bridge classes (feature folders)
    let decoder = JSONDecoder()

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
            port: Self.configuredPort,
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
            onInbound: { [weak self] data in
                Task(priority: .userInitiated) { @MainActor in
                    self?.handleInbound(data)
                }
            },
            onLog: { [weak self] line in
                Task { @MainActor [weak self] in self?.append(.info, line) }
            },
            onClientPaired: { [weak self] in
                Task { @MainActor [weak self] in self?.onMobileClientPaired() }
            },
            onClientDisconnected: { [weak self] in
                Task { @MainActor [weak self] in self?.onMobileClientDisconnected() }
            },
            onListening: { [weak self] boundPort in
                Task { @MainActor [weak self] in self?.mobileServerDidBind(port: boundPort, deviceName: name) }
            },
            onBindFailed: { [weak self] error in
                Task { @MainActor [weak self] in self?.reportMobileBindFailure(error) }
            }
        )
        do {
            try server.start()
        } catch {
            // Sync init-time failure (e.g. invalid NWParameters). The common
            // port-in-use case is ASYNC (NWListener delivers EADDRINUSE via
            // `.failed`), handled by `onBindFailed` above — this covers
            // anything `NWListener(...)` throws at construction.
            reportMobileBindFailure(error)
            return
        }
        self.server = server

        // The Bonjour advertiser deliberately does NOT start here: the bind
        // resolves asynchronously and may land on a fallback port, and
        // advertising a port nothing listens on is exactly the phantom the
        // iPhone then misreads as "Wrong PIN". `mobileServerDidBind` starts
        // it with the port that actually took.
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

    /// The listener bound successfully — possibly on a fallback port. Record
    /// the real port and start (or restart) Bonjour advertising it, so the
    /// iPhone's discovery resolves whatever port actually took. A rebind
    /// after the release-lag retry can land here twice; tearing the previous
    /// advertiser down first keeps exactly one advertisement alive.
    private func mobileServerDidBind(port: Int, deviceName: String) {
        activePort = port
        if port != Self.configuredPort {
            append(.info, "Port \(Self.configuredPort) was busy — Mobile Control is on :\(port) instead (Bonjour and the pairing QR already point there)")
        }
        advertiser?.stop()
        let advertiser = MobileBonjourAdvertiser(name: deviceName, port: port)
        advertiser.start()
        self.advertiser = advertiser
    }

    /// Tear down the native server and Bonjour advertisement. Idempotent —
    /// safe to call from the Quit hook, the Stop button, or a failed restart.
    func stop() {
        workspaceWatcher?.stop()
        workspaceWatcher = nil
        sessionDirectoryWatcher?.stop()
        sessionDirectoryWatcher = nil
        mobilePushCancellables.removeAll()
        autoTaskBridge?.removePushObservers()
        loopBridge?.removePushObservers()
        onMobileClientDisconnected()
        server?.stop()
        server = nil
        advertiser?.stop()
        advertiser = nil
        activePort = nil
        status = .stopped
    }

    /// Stop, then start again. Used by Settings → Mobile Control →
    /// Kill & Restart.
    ///
    /// Deliberately does NOT sleep between the two. `stop()` hands the
    /// listener's `cancel()` to a serial queue, so the port can still be
    /// releasing when the new listener binds — that lag is exactly what
    /// `MobileWebSocketServer`'s bounded EADDRINUSE retry exists to absorb.
    /// The old UI wrapped this in a hard-coded 0.5 s delay, which both raced
    /// the release and hid the real problem: `stop()` was not cancelling the
    /// listener at all, so the wait could never have been long enough.
    func restart() {
        stop()
        start()
    }

    /// Report that the native WebSocket listener could not bind. The common
    /// case is EADDRINUSE — another process (e.g. the retired computer-agent)
    /// is squatting on `:3006`. `start()` cannot catch this synchronously
    /// because `NWListener` delivers the bind failure asynchronously via
    /// `.failed`; the server surfaces it through `onBindFailed`. Tear down
    /// whatever `start()` optimistically stood up and crash loudly with the
    /// actionable `lsof -i :3006` hint instead of a silent, phantom `.running`
    /// — the root cause of the "Wrong PIN" misdiagnosis on the phone.
    private func reportMobileBindFailure(_ error: Error) {
        let base = Self.configuredPort
        let last = base + MobileWebSocketServer.defaultPortCandidates - 1
        lastError = "Couldn't start the mobile server — ports \(base)–\(last) all failed to bind. Run `lsof -i :\(base)` to see what's using them, or set a different port in Settings → Mobile Control, then press Start again. (\(error.localizedDescription))"
        append(.stderr, "ERROR: mobile server bind failed: \(error.localizedDescription)")
        stop()                              // idempotent: stops server/advertiser/watchers
        status = .crashed(exitCode: -1)     // stop() sets .stopped; override to .crashed
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
    /// feature channels into their own methods: the `llmide_chat` arm stays
    /// inline (a single decode + `handleChat`); `explore_*` →
    /// `handleExplore(type:data:)`; `auto_task_*`/`loop_*` → whichever
    /// `MobileFeatureBridge` is installed, via `routeToFeatureBridge` (Phase
    /// 2c Task 1 — see `MobileFeatureBridge.swift`). Tag strings come from the
    /// single source of truth in `MobileProtocol.Tag`. Unknown types log and
    /// drop.
    private func handleInbound(_ data: Data) {
        struct Envelope: Decodable { let type: String }
        guard let env = try? decoder.decode(Envelope.self, from: data) else {
            let preview = String(data: data, encoding: .utf8) ?? "<\(data.count) bytes>"
            append(.info, "Unhandled inbound (no type): \(preview)")
            return
        }

        // Debug: Log all received message types
        let preview = String(data: data, encoding: .utf8)?.prefix(100) ?? "<binary>"
        append(.info, "📨 Received type='\(env.type)' data: \(preview)")

        switch env.type {
        case MobileProtocol.Tag.llmIdeChat:
            // Phase 3/4 chat proxy — must keep working alongside explorer ops.
            if let chat = try? decoder.decode(LlmIdeChat.self, from: data) {
                append(.info, "Chat: \(chat.text.prefix(40))")
                registerMobileInflightTask(commandId: chat.commandId) {
                    await self.handleChat(chat)
                }
            } else {
                let preview = String(data: data, encoding: .utf8)?.prefix(100) ?? "<binary>"
                append(.stderr, "llmide_chat decode failed: \(preview)")
            }
        case MobileProtocol.Tag.llmIdeCancel:
            handleLlmIdeCancel(data: data)
        case MobileProtocol.Tag.llmIdeChatHistoryList:
            Task { await handleLlmIdeChatHistoryList(data: data) }
        case MobileProtocol.Tag.llmIdeChatHistoryClear:
            Task { await handleLlmIdeChatHistoryClear() }
        case MobileProtocol.Tag.macStatusList:
            Task { await handleMacStatusList() }
        case let t where t.hasPrefix("explore_"):
            handleExplore(type: t, data: data)
        case let t where routeToFeatureBridge(type: t, data: data):
            break
        default:
            append(.info, "Unhandled inbound type: \(env.type)")
        }
    }

    /// Feature message types the auto-task bridge owns — copied verbatim from
    /// the pre-split `handleAutoTask`/`handleAutoTaskSetup` switch cases.
    ///
    /// Internal (not `private`) so `MobileFeatureBridgeTests` can pin this Set
    /// against a hardcoded literal: adding a new `SharedProtocol` message type
    /// must update BOTH the bridge's `handle(type:data:)` switch AND this Set
    /// AND that test — a type present here but missing from the switch, or
    /// vice versa, silently misroutes.
    static let autoTaskMessageTypes: Set<String> = [
        MobileProtocol.Tag.autoTaskList,
        MobileProtocol.Tag.autoTaskToggle,
        MobileProtocol.Tag.autoTaskRun,
        MobileProtocol.Tag.autoTaskStop,
        MobileProtocol.Tag.autoTaskHistory,
        MobileProtocol.Tag.autoTaskLogsList,
        MobileProtocol.Tag.autoTaskSetupList,
        MobileProtocol.Tag.autoTaskConfigSet,
        MobileProtocol.Tag.autoTaskTemplateSave,
        MobileProtocol.Tag.autoTaskTemplateRename,
        MobileProtocol.Tag.autoTaskTemplateDelete,
    ]

    /// Feature message types the loop bridge owns — copied verbatim from the
    /// pre-split `handleLoop` switch cases.
    ///
    /// Internal (not `private`) so `MobileFeatureBridgeTests` can pin this Set
    /// against a hardcoded literal — see `autoTaskMessageTypes`'s doc comment
    /// for why: a new `SharedProtocol` message type must update BOTH the
    /// bridge switch AND the Set AND that test.
    static let loopMessageTypes: Set<String> = [
        MobileProtocol.Tag.loopStatusList,
        MobileProtocol.Tag.loopStart,
        MobileProtocol.Tag.loopStartStage,
        MobileProtocol.Tag.loopStop,
        MobileProtocol.Tag.loopHistory,
    ]

    /// Route an auto-task/loop message type to its installed feature bridge.
    /// Returns `true` when `type` belongs to either feature's message set —
    /// the caller (the `handleInbound` switch) must NOT fall through to the
    /// unknown-type path in that case, even when the bridge slot is nil: a
    /// nil bridge still answers with `replyFeatureUnavailable` so the phone
    /// gets a concrete reason instead of a silent drop. Returns `false` only
    /// for a type neither feature owns.
    func routeToFeatureBridge(type: String, data: Data?) -> Bool {
        if Self.autoTaskMessageTypes.contains(type) {
            guard let autoTaskBridge else {
                replyFeatureUnavailable(feature: "Auto Tasks", commandId: type)
                return true
            }
            return autoTaskBridge.handle(type: type, data: data)
        }
        if Self.loopMessageTypes.contains(type) {
            guard let loopBridge else {
                replyFeatureUnavailable(feature: "Loop", commandId: type)
                return true
            }
            return loopBridge.handle(type: type, data: data)
        }
        return false
    }

    /// A feature bridge slot is nil (the feature is compiled out, or not yet
    /// wired) — mirror a `CommandError` to the client and a stderr line to
    /// the Mac log, the same shape `replyNotConfigured` uses.
    private func replyFeatureUnavailable(feature: String, commandId: String) {
        append(.stderr, "\(commandId): \(feature) not installed")
        reply(CommandError(commandId: commandId, message: "\(feature) not installed"))
    }

    /// Handle `explore_*` messages: list / load / new / delete / chat for the
    /// Mac-local explorer-chat sessions (`ChatSessionStore`, scope `.explorer`).
    /// Each case is the pre-existing body moved verbatim from the old
    /// monolithic `handleInbound` switch; the shared `decoder`, `reply(_:)`,
    /// and `append(_:_:)` helpers are unchanged. Mirrors the iOS receive loop.
    private func handleExplore(type: String, data: Data) {
        append(.info, "🔍 handleExplore type='\(type)'")
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
            let turns = s.messages.map { ChatTurn(from: $0.wireTurn()) }
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
            if let m = try? decoder.decode(ExploreDeleteSession.self, from: data),
               let uid = UUID(uuidString: m.sessionId) {
                // Async (the session-memory forget is a network call); this
                // message carries no commandId, so there is no inflight
                // registration or cancel tracking — see handleExploreDelete.
                Task { @MainActor [weak self] in
                    await self?.handleExploreDelete(uid)
                }
            }
        case MobileProtocol.Tag.exploreChat:
            if let chat = try? decoder.decode(ExploreChat.self, from: data) {
                append(.info, "Explore chat in \(chat.sessionId.prefix(8))")
                registerMobileInflightTask(commandId: chat.commandId) {
                    await self.handleExploreChat(chat)
                }
            } else {
                let preview = String(data: data, encoding: .utf8)?.prefix(100) ?? "<binary>"
                append(.stderr, "explore_chat decode failed: \(preview)")
            }
        case MobileProtocol.Tag.exploreCancel:
            handleExploreCancel(data: data)
        case MobileProtocol.Tag.exploreRenameSession:
            handleExploreRenameSession(data: data)
        case MobileProtocol.Tag.exploreSearchFiles:
            if let req = try? decoder.decode(ExploreSearchFiles.self, from: data) {
                handleExploreSearch(req)
            } else {
                let preview = String(data: data, encoding: .utf8)?.prefix(100) ?? "<binary>"
                append(.stderr, "explore_search_files decode failed: \(preview)")
                // Reply with an error so the phone clears its search spinner —
                // it only resets isSearchingWorkspace on a search reply.
                reply(ExploreSearchReply(workspaceRoot: nil, matches: [],
                                         error: "Invalid file-search request from phone."))
            }
        case MobileProtocol.Tag.exploreSearchSkills:
            if let req = try? decoder.decode(ExploreSearchSkills.self, from: data) {
                Task { await handleExploreSearchSkills(req) }
            } else {
                let preview = String(data: data, encoding: .utf8)?.prefix(100) ?? "<binary>"
                append(.stderr, "explore_search_skills decode failed: \(preview)")
                reply(ExploreSkillListReply(matches: [],
                                            error: "Invalid skill-search request from phone."))
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
        // Forward the Mac user's selected provider/model (same source as
        // explore_chat) so a non-Anthropic provider is used instead of the
        // server defaulting to Anthropic → the claude CLI → "not logged in".
        let (model, provider) = MobileExploreBridge.modelAndProvider(config: config)
        do {
            let reply = try await api.askAgent(message: message, history: history, images: images,
                                                model: model, provider: provider)
            guard !isMobileCommandCancelled(chat.commandId) else { return }
            await server?.send(Output(commandId: chat.commandId,
                                      payload: OutputPayload(stream: reply, done: true)))
            NotificationCenter.default.post(name: .llmChatTranscriptChanged, object: nil)
        } catch is CancellationError {
            append(.info, "llmide_chat cancelled: \(chat.commandId.prefix(8))")
        } catch {
            guard !isMobileCommandCancelled(chat.commandId) else { return }
            append(.stderr, "askAgent failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
            await server?.send(CommandError(commandId: chat.commandId, message: error.localizedDescription))
        }
    }

    /// Proxy an explorer chat turn through a `ChatEngine` — the SAME shared
    /// instance the Mac Explorer panel renders (`ChatEngineRegistry.shared`,
    /// Task 12) when that's safe, or a private off-screen engine when it
    /// isn't (`ExplorerMobileEngineResolver` — see its doc comment: the
    /// shared engine must never be force-switched away from a DIFFERENT
    /// session the Mac is already showing, since that would silently cancel
    /// the Mac user's in-flight turn and yank their screen to an unrelated
    /// chat). Persistence, the synthetic-turn append, and the streamed round
    /// trip all go through `ChatEngine.runExternalTurn`, a 1:1 mirror of the
    /// panel's own `runTurn` — no direct `ChatSessionStore` reads/writes here.
    ///
    /// The engine is resolved as LATE as possible — right before
    /// `runExternalTurn`, after every `await` this method does on the way
    /// there (`MobileExploreBridge.buildAgentContext`'s `git` subprocesses in
    /// particular, which can take hundreds of ms to seconds on a large
    /// repo). Code review caught that resolving it any earlier reopens a
    /// version of the exact hijack `explorerMobileEngineResolver` exists to
    /// prevent: the shared engine could be switched to a different session
    /// by the Mac user during that window, between resolve and use. This
    /// narrows the window but — since resolving still can't be the LAST
    /// thing before the turn actually starts touching state — doesn't fully
    /// close it; `runExternalTurn`'s own `expectedSessionID` guard is what
    /// actually closes it.
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
        // on the Mac while the phone still holds an old id) must not silently
        // run a turn against whatever session happens to be active. Surface
        // it as a CommandError so the phone can reload its explorer session
        // list.
        guard ChatSessionStore.load(id: sid) != nil else {
            append(.info, "explore_chat: session \(chat.sessionId.prefix(8)) not found")
            await server?.send(CommandError(commandId: chat.commandId, message: "Session not found on Mac — it may have been deleted. Reload your explorer sessions."))
            return
        }
        var attachments = MobileExploreBridge.attachments(from: chat.files)
        if let root = mobileWorkspaceURL(), !chat.refs.isEmpty {
            let (refAttachments, refErrors) = MobileWorkspaceSearch.attachments(
                from: chat.refs, workspaceRoot: root)
            attachments.append(contentsOf: refAttachments)
            for err in refErrors { append(.info, "explore_chat: \(err)") }
        }
        let agentMessage = MobileWorkspaceSearch.promptWithRefs(chat.text, refs: chat.refs)
        let (skillMessage, skillIds) = MobileSkillCatalog.resolveMessage(agentMessage, skills: chat.skills)
        let (model, provider) = MobileExploreBridge.modelAndProvider(config: config)
        let agentContext: AgentContext?
        if let config, let projectStore {
            // The slowest step here — up to 4 `repoManager.runGit`
            // subprocesses — is exactly why engine resolution happens AFTER
            // this, not before (see this method's doc comment).
            agentContext = await MobileExploreBridge.buildAgentContext(
                config: config, projectStore: projectStore, sessionId: chat.sessionId)
        } else {
            agentContext = nil
            if !chat.files.isEmpty || !chat.refs.isEmpty {
                append(.info, "explore_chat: Mac workspace not wired — attachments/refs may be limited")
            }
        }
        let shared = ChatEngineRegistry.shared.engine(for: .explorer, api: api)
        guard let engine = explorerMobileEngineResolver.engine(for: sid, sharedExplorerEngine: shared, api: api) else {
            append(.info, "explore_chat: could not resolve session \(chat.sessionId.prefix(8))")
            await server?.send(CommandError(commandId: chat.commandId, message: "Could not open that session on your Mac."))
            return
        }
        do {
            let commandId = chat.commandId
            let reply = try await engine.runExternalTurn(
                message: skillMessage,
                skillIds: skillIds,
                attachments: attachments,
                agentContext: agentContext,
                model: model,
                provider: provider,
                expectedSessionID: sid,
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
            await server?.send(Output(commandId: chat.commandId,
                                      payload: OutputPayload(stream: reply, done: true)))
        } catch is CancellationError {
            append(.info, "explore_chat cancelled: \(chat.commandId.prefix(8))")
        } catch {
            guard !isMobileCommandCancelled(chat.commandId) else { return }
            append(.stderr, "code-assist failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
            await server?.send(CommandError(commandId: chat.commandId, message: error.localizedDescription))
        }
    }

    /// Delete an explorer session on behalf of the phone, routed through
    /// whichever engine currently holds it. The old direct
    /// `ChatSessionStore.delete` resurrected the chat whenever an engine
    /// still had it loaded: `persistCurrentChat` recreates the file when
    /// `load(id:)` comes back nil (`?? ChatSession(id:scope:)` keeps the id),
    /// so the Mac panel's next history change — or an in-flight phone turn's
    /// cancellation-path persist — brought the deleted chat right back, and
    /// the server's session-memory rows for it were never forgotten.
    ///
    /// `ChatEngine.deleteSession` already does every piece correctly for a
    /// session its engine is showing (cancel + finalize the in-flight turn,
    /// delete, fall back to the next session or mint a fresh one — which is
    /// also what moves the engine OFF the deleted id so nothing can
    /// re-persist it), so both holders go through it. The shared engine and
    /// a cached off-screen engine can BOTH hold the same id (Mac switched to
    /// a session the phone had opened off-screen), so check each. A session
    /// nobody holds takes the raw delete — plus the memory forget the raw
    /// path used to skip, which is also re-issued unconditionally because
    /// off-screen engines never get a panel to wire their
    /// `forgetSessionMemory` hook (a duplicate server DELETE is idempotent).
    @MainActor
    private func handleExploreDelete(_ uid: UUID) async {
        // `api` is optional only so the network forget at the tail degrades
        // gracefully — the local file delete and engine routing above it
        // must not be skipped when it's nil, or the phone silently keeps a
        // session it deleted.
        let shared = api.map { ChatEngineRegistry.shared.engine(for: .explorer, api: $0) }
        if shared?.currentSessionIDString == uid.uuidString {
            await shared?.deleteSession(uid)
        }
        if let cached = explorerMobileEngineResolver.cachedEngine(for: uid) {
            await cached.deleteSession(uid)
        }
        if ChatSessionStore.load(id: uid) != nil {
            ChatSessionStore.delete(id: uid)
        }
        if let api {
            _ = try? await api.forgetSessionMemory(sessionId: uid.uuidString)
        }
        // Drop any cached off-screen engine for this id too — a later
        // explore_chat referencing the same (now-deleted) session must not
        // resolve to a stale cached instance.
        explorerMobileEngineResolver.forget(sessionID: uid)
        append(.info, "Explore delete: \(uid.uuidString.prefix(8))")
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

    // internal: shared with the Mobile*Bridge classes (feature folders)
    func append(_ stream: MobileLogLine.Stream, _ text: String) {
        logLines.append(.init(text: text, stream: stream))
        if logLines.count > maxLogLines {
            logLines.removeFirst(logLines.count - maxLogLines)
        }
    }

    // MARK: - Reply helpers

    /// Fire-and-forget encode + send to the active client. Uses a detached
    /// send task so replies are not queued behind long-running @MainActor work
    /// (Auto Task CLI, code-assist streams) — heartbeats bypass MainActor and
    /// were the only reliable round-trip when the main queue was busy.
    // internal: shared with the Mobile*Bridge classes (feature folders)
    func reply(_ message: some Encodable) {
        guard let server else {
            append(.stderr, "Mobile reply dropped — WebSocket server not running")
            return
        }
        Task.detached(priority: .userInitiated) {
            await server.send(message)
        }
    }

    /// A feature's own dependency isn't wired (e.g. Auto Tasks' `autoCode`) —
    /// mirror a `CommandError` to the client and a stderr line to the Mac log.
    /// `commandId` is the wire discriminator the phone keys on; `logLabel` is
    /// the (separately observable) prefix shown in the Mac log, kept distinct
    /// to preserve the original "auto_task_list"/"auto_task_run" wording.
    // internal: shared with the Mobile*Bridge classes (feature folders)
    func replyNotConfigured(commandId: String, logLabel: String) {
        append(.stderr, "\(logLabel): Auto-tasks not configured")
        reply(CommandError(commandId: commandId, message: "Auto-tasks not configured"))
    }

    // MARK: - Phase A: mobile push sync, cancel, status, rename

    /// Subscribe to explorer session + Mac-project changes and push snapshots
    /// to a paired iPhone without waiting for a pull request; then let each
    /// installed feature bridge do the same for its own slice (Auto Task's
    /// scheduler/settings/logs/templates, previously subscribed here directly
    /// — see `MobileAutoTaskBridge.installPushObservers`).
    func installMobilePushObservers() {
        mobilePushCancellables.removeAll()

        projectStore?.objectWillChange
            .debounce(for: .milliseconds(350), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                Task { await self?.pushMacStatusIfPaired() }
            }
            .store(in: &mobilePushCancellables)

        autoTaskBridge?.installPushObservers()
        loopBridge?.installPushObservers()
    }

    /// Push a fresh Mac status snapshot when backend or project context changes.
    func onMacEnvironmentChanged() {
        Task { await pushMacStatusIfPaired() }
    }

    private func onMobileClientPaired() {
        mobileClientPaired = true
        // An immediate full snapshot for a client that just paired, rather
        // than waiting for the next Combine-debounced change — reusing the
        // same per-type handling `auto_task_list`/`auto_task_logs_list`
        // already do on a direct pull request. Gated on `mobileClientPaired`
        // like every other synthetic push below, so a stopped/unpaired state
        // is a silent no-op instead of a "Mobile reply dropped" stderr line.
        guard mobileClientPaired else { return }
        _ = autoTaskBridge?.handle(type: MobileProtocol.Tag.autoTaskList, data: nil)
        _ = autoTaskBridge?.handle(type: MobileProtocol.Tag.autoTaskLogsList, data: nil)
        pushExploreSessionListIfPaired()
        Task { await pushMacStatusIfPaired() }
    }

    private func onMobileClientDisconnected() {
        mobileClientPaired = false
        mobileCancelledCommandIds.removeAll()
        for task in mobileInflightTasks.values { task.cancel() }
        mobileInflightTasks.removeAll()
    }

    /// Explicit "push now" for the Auto Tasks page's Refresh button, and for
    /// every custom-task mutation (add/toggle/delete/run) — CustomAutoTask is
    /// a plain struct, not independently Combine-observed like autoCode/
    /// autoTaskSettings, so this is the actual sync mechanism for it. Built-in
    /// tasks already auto-push via installMobilePushObservers(); this just
    /// gives an explicit, visible "synced now" affordance on top of that.
    func refreshAutoTaskStateForMobile() {
        // A stopped/unpaired Mac must not push through a dead server — every
        // other synthetic call in this file gates on the same flag; without
        // it, every Mac-side task edit logged a "Mobile reply dropped" line
        // even when nobody was there to receive it.
        guard mobileClientPaired else { return }
        _ = autoTaskBridge?.handle(type: MobileProtocol.Tag.autoTaskList, data: nil)
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
                                          operation: @escaping @MainActor () async -> Void) {
        mobileInflightTasks[commandId]?.cancel()
        mobileCancelledCommandIds.remove(commandId)
        let cid = commandId
        mobileInflightTasks[cid] = Task.detached(priority: .userInitiated) { @MainActor [weak self] in
            guard let self else { return }
            defer { self.mobileInflightTasks.removeValue(forKey: cid) }
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
        guard let m = try? decoder.decode(LlmIdeCancel.self, from: data) else {
            append(.stderr, "llmide_cancel decode failed")
            return
        }
        append(.info, "llmide_cancel \(m.commandId.prefix(8))")
        cancelMobileInflightTask(commandId: m.commandId)
    }

    private func handleLlmIdeChatHistoryList(data: Data) async {
        guard let api else {
            reply(CommandError(commandId: "llmide_chat_history", message: "Backend not configured"))
            return
        }
        struct LimitEnvelope: Decodable { let limit: Int? }
        let limit = (try? decoder.decode(LimitEnvelope.self, from: data))?.limit ?? 50
        do {
            let items = try await api.listAgentAskHistory(limit: limit)
            let messages = items.map { ChatTurn(role: $0.role, content: $0.content) }
            reply(LlmIdeChatHistoryReply(messages: messages))
        } catch {
            reply(CommandError(commandId: "llmide_chat_history", message: error.localizedDescription))
        }
    }

    private func handleLlmIdeChatHistoryClear() async {
        guard let api else {
            reply(CommandError(commandId: "llmide_chat_history_clear", message: "Backend not configured"))
            return
        }
        do {
            _ = try await api.clearAgentAskHistory()
            reply(LlmIdeChatHistoryClearAck(ok: true))
            NotificationCenter.default.post(name: .llmChatTranscriptChanged, object: nil)
        } catch {
            reply(CommandError(commandId: "llmide_chat_history_clear", message: error.localizedDescription))
        }
    }

    private func handleExploreCancel(data: Data) {
        guard let m = try? decoder.decode(ExploreCancel.self, from: data) else {
            append(.stderr, "explore_cancel decode failed")
            return
        }
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
        let backendUp = await BackendManager.probeHealthUsable()
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
/// Defined in the Mac target (not SharedProtocol) because `CodeAssistTurn` is
/// Mac-local and a SharedProtocol-side dependency would be circular.
///
/// Only the → direction survives Task 12: `handleExploreChat` used to decode
/// the phone's own cached `chat.history` (← direction, `CodeAssistTurn.init(
/// from: ChatTurn)`) into the request it sent. It now drives
/// `ChatEngine.runExternalTurn`, which packs the request from the engine's
/// OWN canonical `messages` via `packHistory` — the same source of truth the
/// Mac panel's own turns use — so the phone's cached copy is no longer read
/// for that purpose (`explore_load_session`, the ← direction's other would-be
/// use, only ever needed →, never ←). The `ExploreChat.history` wire field
/// was removed outright in 2026-08-17; an unknown `history` key from an
/// older phone is ignored, but an older Mac decoding a newer phone's
/// message would fail — the two apps update together.
extension ChatTurn {
    /// Code Assistant view-model → SharedProtocol wire shape: drop the
    /// client-only `id`, surface the role as its raw string ("user"/"assistant").
    init(from t: LlmIdeAPIClient.CodeAssistTurn) {
        self.init(role: t.role.rawValue, content: t.content)
    }
}

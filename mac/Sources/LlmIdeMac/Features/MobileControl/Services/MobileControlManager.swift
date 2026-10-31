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
    var autoTaskBridge: MobileFeatureBridge? { didSet { refreshCapabilities() } }
    /// Feature bridge for `loop_*` messages — nil when Loop is compiled out
    /// or not yet wired (see `routeToFeatureBridge`).
    var loopBridge: MobileFeatureBridge? { didSet { refreshCapabilities() } }
    /// Feature bridge for `generation_*` / `llmdoc_*` messages — nil when
    /// Doc Gen is compiled out or not yet wired (see `routeToFeatureBridge`).
    var generationBridge: MobileFeatureBridge? { didSet { refreshCapabilities() } }

    /// Feature bridge for `activity_*` messages (the bell's feed). Wired whenever Mobile is built.
    var activityBridge: MobileFeatureBridge? { didSet { refreshCapabilities() } }

    /// What this Mac advertises in `Connected.capabilities`. A locked snapshot, not a read of the
    /// bridge slots, because the server asks from its own queue while the slots are main-actor.
    private let capabilityBox = CapabilityBox()

    /// The Mac-side switches deciding what the phone may do (Settings → Mobile Control → Phone access).
    let phoneAccess = PhoneAccessSettings()
    /// Native confirmation for phone-started actions that write code, push, or patch the checkout.
    let desktopApproval = PhoneDesktopApprovalGate()

    /// Kept so the shell can inject the "is a run active?" guard (see `MobileProjectBridge.busyReason`).
    var projectBridge: MobileProjectBridge?
    var selfHealBridge: MobileSelfHealBridge?

    /// A bridge registered through `register(...)` rather than a dedicated slot: it owns a set of
    /// message types, advertises capabilities (each optionally behind a `PhoneAccess` switch that
    /// must be ON for the capability to be offered), and gets the same push-observer lifecycle.
    struct RegisteredBridge {
        let bridge: MobileFeatureBridge
        let messageTypes: Set<String>
        let capabilities: [(name: String, gate: PhoneAccess?)]
    }
    private(set) var registeredBridges: [RegisteredBridge] = []

    func register(bridge: MobileFeatureBridge, messageTypes: Set<String>,
                  capabilities: [(name: String, gate: PhoneAccess?)]) {
        registeredBridges.append(RegisteredBridge(bridge: bridge, messageTypes: messageTypes,
                                                  capabilities: capabilities))
        refreshCapabilities()
    }

    /// Capabilities contributed by registered bridges, honouring each one's switch.
    nonisolated static func registeredCapabilities(_ entries: [RegisteredBridge],
                                                   isAllowed: (PhoneAccess) -> Bool) -> [String] {
        entries.flatMap { $0.capabilities }
            .filter { $0.gate.map(isAllowed) ?? true }
            .map(\.name)
    }

    /// Pure so a test can pin it: chat and Explorer are always served; each bridge-backed
    /// feature appears only when its bridge is wired, mirroring `routeToFeatureBridge`.
    nonisolated static func capabilities(autoTasks: Bool, loop: Bool, generation: Bool,
                                         activity: Bool = false) -> [String] {
        var caps = [MobileProtocol.Capability.chat, MobileProtocol.Capability.explorer]
        if autoTasks { caps.append(MobileProtocol.Capability.autoTasks) }
        if loop { caps.append(MobileProtocol.Capability.loop) }
        if generation {
            caps.append(MobileProtocol.Capability.generation)
            caps.append(MobileProtocol.Capability.llmDoc)
        }
        if activity { caps.append(MobileProtocol.Capability.activity) }
        return caps
    }

    private func refreshCapabilities() {
        let caps = Self.capabilities(autoTasks: autoTaskBridge != nil,
                                     loop: loopBridge != nil,
                                     generation: generationBridge != nil,
                                     activity: activityBridge != nil)
            + Self.registeredCapabilities(registeredBridges, isAllowed: { phoneAccess.isAllowed($0) })
        let changed = capabilityBox.value != caps
        capabilityBox.value = caps
        // A phone already connected learned the old list at pairing; tell it about the new one.
        if changed, mobileClientPaired { reply(MacCapabilities(capabilities: caps)) }
    }

    /// Wire the access switches to the capability list. Called once from `init`-time setup.
    func installPhoneAccessObserver() {
        phoneAccess.onChange = { [weak self] in
            self?.refreshCapabilities()
            self?.sweepToolApprovalsIfOff()
        }
    }

    /// Turning "Approve or deny tool and edit requests" off takes any tool prompt currently on the phone
    /// down (the prompt itself stays parked on the Mac), instead of leaving a card that can only be refused.
    private func sweepToolApprovalsIfOff() {
        guard !phoneAccess.isAllowed(.toolApprovals) else { return }
        for (commandId, entry) in pendingPhoneApprovals
        where entry.engine.parkedApproval?.kind == "ToolApproval" {
            pendingPhoneApprovals.removeValue(forKey: commandId)
            truncatedToolRequestIds.remove(entry.requestId)
            Task { await server?.send(ApprovalCleared(
                commandId: commandId, requestId: entry.requestId,
                reason: "Tool requests can no longer be approved from the phone.")) }
        }
    }

    /// Work started from the phone that a project switch or a Self-Heal apply must not pull the rug from
    /// (a running chat/agent turn, a prompt waiting for an answer). Independent of which features are built.
    var phoneWorkReason: String? {
        if !pendingPhoneApprovals.isEmpty { return "A phone chat is waiting for an answer on the Mac. Answer it first." }
        if !mobileInflightTasks.isEmpty { return "A request from the phone is still running on the Mac. Wait for it to finish." }
        return nil
    }
    /// Mac Settings + workspace — used to run iPhone explore prompts with the
    /// same model/provider and agent context as the desktop Explorer panel.
    var config: AppConfig?
    var projectStore: ProjectStore?
    /// Local Node backend supervisor — used for `mac_status` snapshots.
    var backendManager: BackendManager?

    /// Persisted `@file` / `/skill` browse indexes under Application Support settings/.
    let exploreIndex = MobileExploreIndexStore()

    /// Chat's side of every phone chat path — quick chat, Explorer chats and
    /// their sessions, parked approvals — behind the Core seam
    /// (`Core/Contracts/MobileChatHosting.swift`), because Mobile Control may
    /// not name Chat's types. Shell installs Chat's implementation in
    /// `FeatureCatalog.bootMobile`; while nil, every chat request is answered
    /// "Chat not installed" instead of reaching an engine. Strong: nothing
    /// else keeps the host (and the off-screen engine pool it owns) alive.
    var chatHost: (any MobileChatHosting)?

    /// The question each in-flight phone turn is parked on, with the engine
    /// holding it — so the answer goes back to THAT engine, and the turn's end
    /// can take the phone's card down.
    ///
    /// Keyed by commandId and carrying the engine because the two phone arms
    /// run on different ones: `llmide_chat` on the quick-chat engine,
    /// `explore_chat` on whichever the resolver picked (shared or off-screen).
    /// Looking the engine up again at answer time would find the wrong one.
    private var pendingPhoneApprovals: [String: (engine: any MobileChatTurnEngine, requestId: String)] = [:]
    /// Tool prompts whose shown content was cut (by the server or by `MobileToolApproval`): the phone
    /// cannot allow what it could not read, so the Mac refuses `allow` for these.
    private var truncatedToolRequestIds: Set<String> = []
    /// Which phone command installed each engine's `onExternalApproval` hook.
    /// The hook is a single slot per engine, so `endPhoneApprovals` may only
    /// clear it when it still belongs to the command that is ending — see
    /// `beginPhoneApprovals`.
    private var phoneApprovalOwners: [ObjectIdentifier: String] = [:]

    private var server: MobileWebSocketServer?
    private var advertiser: MobileBonjourAdvertiser?
    private var workspaceWatcher: RepoFileWatcher?
    private var sessionDirectoryWatcher: RepoFileWatcher?
    private let maxLogLines = 5_000

    /// True after a client completes PIN pairing; cleared on disconnect.
    // internal: shared with the Mobile*Bridge classes (feature folders)
    var mobileClientPaired = false
    /// Phones that completed PIN pairing and hold a per-device token — the
    /// registry token auth checks against, and what Settings lists/revokes.
    private let pairedDeviceStore = MobilePairedDeviceStore()
    /// Snapshot of `pairedDeviceStore.all` for the Settings list, refreshed on
    /// every pairing, authentication, and revoke.
    private(set) var pairedDevices: [MobilePairedDeviceStore.Device] = []
    /// Device id of the phone currently connected; nil when none is, or when a
    /// legacy phone paired with a bare PIN and has no id.
    private(set) var connectedDeviceId: String?
    /// Bumped on every successful pairing (including a replacement and a
    /// token reconnect). State that must belong to ONE phone session — the
    /// Self-Heal reviewed-patch cache — binds to `phoneSessionIdentity`, so
    /// two PIN-only phones (both `connectedDeviceId == nil`) never share it.
    private(set) var phoneSessionGeneration = 0

    /// The current phone session's identity, or nil when no phone is paired.
    var phoneSessionIdentity: String? {
        guard mobileClientPaired else { return nil }
        return Self.makePhoneSessionIdentity(generation: phoneSessionGeneration, deviceId: connectedDeviceId)
    }

    nonisolated static func makePhoneSessionIdentity(generation: Int, deviceId: String?) -> String {
        "\(generation):\(deviceId ?? "pin-only")"
    }
    /// Bumped each time the pairing PIN rotates so Settings re-reads the PIN
    /// and redraws the QR.
    private(set) var pinGeneration = 0
    private var mobilePushCancellables = Set<AnyCancellable>()
    /// One phone command's running task, tagged with a per-registration token
    /// so a finishing task can tell whether the slot is still its own.
    private struct MobileInflightTask {
        let token: UUID
        let task: Task<Void, Never>
    }
    private var mobileInflightTasks: [String: MobileInflightTask] = [:]
    /// Command ids with a registered, not-yet-finished task (tests).
    var mobileInflightCommandIds: Set<String> { Set(mobileInflightTasks.keys) }
    /// Commands the iPhone cancelled — late HTTP replies must not persist or stream.
    // private(set), not private: pinned by MobileInflightTaskTests
    private(set) var mobileCancelledCommandIds = Set<String>()

    /// Shared decoder reused across every `handleInbound` case. `JSONDecoder`
    /// is thread-safe for independent `decode(_:)` calls and this manager is
    /// `@MainActor`, so reusing one instance avoids the per-case allocation
    /// (previously ~7 fresh decoders per inbound dispatch).
    // internal: shared with the Mobile*Bridge classes (feature folders)
    let decoder = JSONDecoder()

    init() {
        pairedDevices = pairedDeviceStore.all
        installPhoneAccessObserver()
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
        // A paired phone's token is a long-lived credential of the account
        // that paired it; the Keychain wipe on "disconnect all" never reached
        // it (its hash lives in `MobilePairedDeviceStore`'s file).
        NotificationCenter.default.addObserver(
            forName: .accountCredentialsRevoked,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.revokeAllDevices()
            }
        }
    }

    // MARK: - Start / stop

    /// The switch that lets the phone DELETE Mac chats (`explore_delete_session`,
    /// `llmide_chat_history_clear`). There is no dedicated chat-deletion
    /// switch; `exploreEdit` is the existing default-OFF switch that already
    /// decides whether the phone may change Mac-side state through chat, and
    /// a deleted chat is as irreversible as an edited file. Read-only phone
    /// chat keeps working with it off.
    nonisolated static let chatDeletionSwitch: PhoneAccess = .exploreEdit

    nonisolated static func chatDeletionAllowed(_ isAllowed: (PhoneAccess) -> Bool) -> Bool {
        isAllowed(chatDeletionSwitch)
    }

    /// The pairing-PIN check behind `validatePin`.
    ///
    /// Fails CLOSED when the current PIN can't be read: falling back to the
    /// PIN captured at start could resurrect one that has since been retired
    /// (rotated in memory while its Keychain persist failed, then the session
    /// cache cleared). Compared in constant time, like device tokens.
    nonisolated static func pinMatches(candidate: String, current: String?) -> Bool {
        guard let current, !current.isEmpty else { return false }
        // The PIN is always 6 digits (`%06d`), but a user typing on a phone
        // number pad often omits leading zeros (e.g. "42" for "000042").
        // Left-zero-pad an all-ASCII-digit candidate of ≤6 chars before
        // comparing so that omission still matches, without weakening the
        // check for any other input.
        let isAllDigits = !candidate.isEmpty
            && candidate.allSatisfy { ("0"..."9").contains($0) }
        let normalized = (candidate.count <= 6 && isAllDigits)
            ? String(repeating: "0", count: 6 - candidate.count) + candidate
            : candidate
        return MobilePairedDeviceStore.constantTimeEqual(normalized, current)
    }

    func start() {
        if case .running = status { return }
        if case .starting = status { return }

        status = .starting

        guard ((try? MobilePin.ensure()) ?? MobilePin.read()) != nil else {
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
                // Read the PIN at validation time, not the one captured when
                // the server started: it rotates after every token-issuing
                // pairing (`onPinConsumed`), and the stale capture would keep
                // accepting the retired PIN. `read()` is the session cache.
                Self.pinMatches(candidate: candidate, current: MobilePin.read())
            },
            authenticateToken: { [pairedDeviceStore] deviceId, token in
                pairedDeviceStore.authenticate(deviceId: deviceId, token: token)
            },
            issueToken: { [pairedDeviceStore] deviceId, deviceName in
                pairedDeviceStore.issueToken(deviceId: deviceId, name: deviceName)
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
            onClientIdentified: { [weak self] deviceId in
                Task { @MainActor [weak self] in
                    self?.connectedDeviceId = deviceId
                    self?.refreshPairedDevices()
                }
            },
            onPinConsumed: { [weak self] in
                // Retire the PIN HERE, synchronously on the server's queue, so
                // it is dead before the next frame is examined — a MainActor
                // hop would leave it valid for a few milliseconds. Only the
                // in-memory half runs on the queue; the Keychain write happens
                // off it (a SecItem write can block in securityd, and this
                // queue serialises every frame the server handles).
                let fresh = MobilePin.rotateInMemory()
                Task.detached(priority: .utility) { [weak self] in
                    let persisted = (try? MobilePin.persist(fresh)) != nil
                    // Own capture list: referencing the outer `weak var self`
                    // from this nested @Sendable closure is a Swift 6 error.
                    await MainActor.run { [weak self] in self?.pinDidRotate(persisted: persisted) }
                }
            },
            onClientDisconnected: { [weak self] in
                Task { @MainActor [weak self] in self?.onMobileClientDisconnected() }
            },
            onListening: { [weak self] boundPort in
                Task { @MainActor [weak self] in self?.mobileServerDidBind(port: boundPort, deviceName: name) }
            },
            onBindFailed: { [weak self] error in
                Task { @MainActor [weak self] in self?.reportMobileBindFailure(error) }
            },
            capabilities: { [capabilityBox] in capabilityBox.value }
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

    /// Set when files changed while no phone was paired (the forced reindex was
    /// skipped), so the index may be stale; pairing triggers one refresh.
    private var workspaceChangedWhileUnpaired = false

    private func onWorkspaceFilesChanged() {
        guard case .running = status, let root = mobileWorkspaceURL() else { return }
        // With no phone paired nobody reads the index; a later search rebuilds it once it is stale
        // (`workspaceStaleInterval`), so a forced walk after every file change would be wasted work.
        guard mobileClientPaired else {
            workspaceChangedWhileUnpaired = true
            return
        }
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
        generationBridge?.removePushObservers()
        activityBridge?.removePushObservers()
        registeredBridges.forEach { $0.bridge.removePushObservers() }
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
    func handleInbound(_ data: Data) {
        struct Envelope: Decodable { let type: String }
        guard let env = try? decoder.decode(Envelope.self, from: data) else {
            // Never the frame itself: it is phone-controlled and up to 8 MiB.
            append(.info, "Unhandled inbound (\(MobileLogPolicy.frameLabel(data)))")
            return
        }

        // Type and size only — see MobileLogPolicy for why never content.
        append(.info, "📨 Received type='\(MobileLogPolicy.typeLabel(env.type))', \(data.count) bytes")

        // THE tier gate: one table, one place, before any bridge sees the frame. Unknown types, Mac-to-phone
        // types and desktop-only types are refused here with a typed code (never a crash, never silent).
        if case .refuse(let code, let message) = PhoneTierTable.verdict(for: env.type) {
            append(.stderr, "Tier gate refused '\(MobileLogPolicy.typeLabel(env.type))' (\(code))")
            reply(CommandError(commandId: MobileLogPolicy.typeLabel(env.type), message: message, code: code))
            return
        }

        switch env.type {
        case MobileProtocol.Tag.llmIdeChat:
            // Phase 3/4 chat proxy — must keep working alongside explorer ops.
            if let chat = try? decoder.decode(LlmIdeChat.self, from: data) {
                append(.info, "Chat: \(chat.text.count) chars")
                registerMobileInflightTask(commandId: chat.commandId) {
                    await self.handleChat(chat)
                }
            } else {
                append(.stderr, "llmide_chat decode failed (\(MobileLogPolicy.frameLabel(data)))")
                replyDecodeFailure(data, what: "chat request")
            }
        case MobileProtocol.Tag.llmIdeCancel:
            handleLlmIdeCancel(data: data)
        case MobileProtocol.Tag.toolApprovalAnswer:
            if let answer = try? decoder.decode(ToolApprovalAnswer.self, from: data) {
                Task { await handleToolApprovalAnswer(answer) }
            } else {
                append(.stderr, "tool_approval_answer decode failed")
                replyDecodeFailure(data, what: "tool approval answer")
            }
        case MobileProtocol.Tag.approvalAnswer:
            if let answer = try? decoder.decode(ApprovalAnswer.self, from: data) {
                Task { await handleApprovalAnswer(answer) }
            } else {
                append(.stderr, "approval_answer decode failed")
                replyDecodeFailure(data, what: "approval answer")
            }
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
            append(.info, "Unhandled inbound type: \(MobileLogPolicy.typeLabel(env.type))")
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

    /// Feature message types the generation bridge owns (Doc Gen / Visual runs
    /// and the read-only `llm-doc/` browser). Pinned by `MobileFeatureBridgeTests`.
    static let generationMessageTypes: Set<String> = [
        MobileProtocol.Tag.generationOptionsList,
        MobileProtocol.Tag.generationRun,
        MobileProtocol.Tag.llmDocList,
        MobileProtocol.Tag.llmDocRead,
    ]

    /// Feature message types the activity bridge owns. Pinned by `MobileFeatureBridgeTests`.
    static let activityMessageTypes: Set<String> = [
        MobileProtocol.Tag.activityList,
        MobileProtocol.Tag.activityMarkSeen,
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
        if Self.activityMessageTypes.contains(type) {
            guard let activityBridge else {
                // Reply-shaped so the phone's feed stops loading instead of waiting on a CommandError.
                reply(ActivityState(entries: [], unread: 0))
                return true
            }
            return activityBridge.handle(type: type, data: data)
        }
        if let entry = registeredBridges.first(where: { $0.messageTypes.contains(type) }) {
            return entry.bridge.handle(type: type, data: data)
        }
        if Self.generationMessageTypes.contains(type) {
            guard let generationBridge else {
                replyGenerationUnavailable(type: type, data: data)
                return true
            }
            return generationBridge.handle(type: type, data: data)
        }
        return false
    }

    /// The generation bridge slot is nil. Unlike the other bridges, the phone waits on a reply
    /// shaped for each message (run → result, list → listing, …) keyed by its own id/path, so a
    /// generic `CommandError(commandId: <type>)` would leave its spinner running.
    private func replyGenerationUnavailable(type: String, data: Data?) {
        let why = "Doc Gen isn't available on this Mac right now. Make sure LLM-IDE is fully open and a project is active."
        append(.stderr, "\(type): Doc Gen not installed")
        func field(_ key: String) -> String? {
            guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return obj[key] as? String
        }
        switch type {
        case MobileProtocol.Tag.generationRun:
            reply(GenerationResult(commandId: field("commandId") ?? type, ok: false, error: why))
        case MobileProtocol.Tag.generationOptionsList:
            reply(GenerationOptions(available: false, projectName: nil, templates: [], commands: [],
                                    saveFolder: "llm-doc/generated"))
        case MobileProtocol.Tag.llmDocList:
            reply(LlmDocListing(path: field("path") ?? "", entries: [], error: why))
        case MobileProtocol.Tag.llmDocRead:
            reply(LlmDocFile(path: field("path") ?? "", text: nil, error: why))
        default:
            reply(CommandError(commandId: type, message: "Doc Gen not installed"))
        }
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
            // Mac-local Explorer chats (Chat's session store, scope `.explorer`).
            guard let chatHost else {
                replyFeatureUnavailable(feature: "Chat", commandId: "explore_list")
                return
            }
            let rows = Self.exploreSummaries(chatHost.explorerSessions(visibleInProject: activeExplorerProjectId))
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
            guard let chatHost else {
                replyFeatureUnavailable(feature: "Chat", commandId: "explore_load")
                return
            }
            guard let s = chatHost.explorerSession(id: sid, visibleInProject: activeExplorerProjectId) else {
                append(.info, "Explore load: session \(sid.uuidString.prefix(8)) not found")
                reply(CommandError(commandId: "explore_load",
                                   message: "Session not found on Mac — it may have been deleted."))
                return
            }
            let turns = s.lines.map { ChatTurn(role: $0.role, content: $0.content) }
            append(.info, "Explore load: \(s.id.uuidString.prefix(8))")
            reply(ExploreSessionHistory(sessionId: s.id.uuidString,
                                        title: s.title,
                                        history: turns))
        case MobileProtocol.Tag.exploreNewSession:
            guard let chatHost else {
                replyFeatureUnavailable(feature: "Chat", commandId: "explore_new")
                return
            }
            let newId = chatHost.createExplorerSession(projectId: activeExplorerProjectId)
            append(.info, "Explore new: \(newId.uuidString.prefix(8))")
            reply(ExploreSessionCreated(sessionId: newId.uuidString))
        case MobileProtocol.Tag.exploreDeleteSession:
            // Refused synchronously, before the phone's follow-up re-list is
            // handled, so the list it gets back still shows the kept session.
            // `explore_`-prefixed so the phone's Explorer store surfaces it.
            guard Self.chatDeletionAllowed({ phoneAccess.isAllowed($0) }) else {
                append(.info, "Explore delete refused — \"\(Self.chatDeletionSwitch.title)\" is off")
                reply(CommandError(commandId: "explore_delete",
                                   message: Self.chatDeletionSwitch.deniedMessage))
                return
            }
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
                append(.stderr, "explore_chat decode failed (\(MobileLogPolicy.frameLabel(data)))")
                replyDecodeFailure(data, what: "explorer chat request")
            }
        case MobileProtocol.Tag.exploreCancel:
            handleExploreCancel(data: data)
        case MobileProtocol.Tag.exploreRenameSession:
            handleExploreRenameSession(data: data)
        case MobileProtocol.Tag.exploreSearchFiles:
            if let req = try? decoder.decode(ExploreSearchFiles.self, from: data) {
                handleExploreSearch(req)
            } else {
                append(.stderr, "explore_search_files decode failed (\(MobileLogPolicy.frameLabel(data)))")
                // Reply with an error so the phone clears its search spinner —
                // it only resets isSearchingWorkspace on a search reply.
                reply(ExploreSearchReply(workspaceRoot: nil, matches: [],
                                         error: "Invalid file-search request from phone."))
            }
        case MobileProtocol.Tag.exploreSearchSkills:
            if let req = try? decoder.decode(ExploreSearchSkills.self, from: data) {
                Task { await handleExploreSearchSkills(req) }
            } else {
                append(.stderr, "explore_search_skills decode failed (\(MobileLogPolicy.frameLabel(data)))")
                reply(ExploreSkillListReply(matches: [],
                                            error: "Invalid skill-search request from phone."))
            }
        default:
            append(.info, "Unhandled explore type: \(MobileLogPolicy.typeLabel(type))")
        }
    }

    /// Find files/folders on the Mac workspace by name (for iPhone @file picker).
    private func handleExploreSearch(_ req: ExploreSearchFiles) {
        // Same switch as the Files browser: this lists the project's file names to the phone.
        guard phoneAccess.isAllowed(.fileBrowse) else {
            reply(ExploreSearchReply(workspaceRoot: nil, matches: [], error: PhoneAccess.fileBrowse.deniedMessage))
            return
        }
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
            append(.info, "Explore search (\(req.query.count) chars) → \(matches.count) hit(s) [index]")
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
        append(.info, "Explore skill search (\(req.query.count) chars) → \(matches.count) hit(s) [index]")
        reply(ExploreSkillListReply(matches: matches, error: nil))
    }

    /// Active explorer code root — same precedence as `ExplorerView.root`.
    func mobileWorkspaceURL() -> URL? {
        guard let config, let projectStore else { return nil }
        if let code = projectStore.activeProjectCodeDir { return code }
        return WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }

    /// Drive a phone chat turn through the SAME shared `.quick` `ChatEngine`
    /// the menu bar and the LLM Chat sheet drive (`ChatEngineRegistry`) —
    /// one conversation across all three surfaces, rather than the phone
    /// silently keeping its own `/kb/agent/ask` transcript after the Mac
    /// surfaces moved onto the code pipeline. Mirrors `handleExploreChat`
    /// below: cancellation via `registerMobileInflightTask` and `Output`/
    /// `CommandError` framing. (No transcript-changed notification on
    /// success any more — see `NotificationNames.swift`: the engine owns the
    /// transcript, so the post had no observers left.)
    private func handleChat(_ chat: LlmIdeChat) async {
        guard let api else {
            await server?.send(CommandError(commandId: chat.commandId, message: "Backend not configured"))
            return
        }
        guard let chatHost else {
            replyFeatureUnavailable(feature: "Chat", commandId: chat.commandId)
            return
        }
        // This knowingly removes a WORKING path, and the loss is real: the
        // phone sends real image bytes (`chat.images`), and until this branch
        // they reached the model — `api.askAgent(message:history:images:)`
        // serialised them as image content blocks to `/kb/agent/ask`, which
        // `extension/routes/agent.mjs` forwards to `runClaude(..., images)`.
        // (The spec says otherwise, citing `AgentAskTransport`'s hardcoded
        // `images: []`; that transport was the MAC sheet's, never the phone's,
        // and the phone never went through it.) The code pipeline this chat
        // now runs on carries no images at all — `ChatTransportInput`/
        // `runExternalTurn` have no image parameter — so refuse visibly
        // rather than silently discard what the user watched upload.
        guard chat.images.isEmpty else {
            // Do NOT send the user to the Mac app: neither `MenuBarChatView`
            // nor `LlmChatSheet` has an attach affordance, and both run the
            // same image-less transport (see `VisualSourcePanel.swift`, which
            // states the same fact for Doc Gen's sources).
            await server?.send(Output(commandId: chat.commandId, payload: OutputPayload(
                stream: "Images aren't supported in this chat — send the question as text. "
                    + "No LLM-IDE chat surface can send an image to the model right now.",
                done: true)))
            return
        }
        // The phone has NO approval UI at all, so this is the worst surface
        // for the unsafe fallback: an older server resolving `ask` to
        // `execute` would run full act tools with nothing anywhere to
        // render a card. Checked before resolving/driving the engine, and
        // reported as a normal Output (never CommandError, matching the
        // no-project reply below) so the phone renders it as an answer, not
        // a failure.
        //
        // One fresh probe per question, whichever way the cached version
        // reads. It has to run when the gate looks CLOSED, because the phone
        // has no view to poll from (the Mac surfaces re-probe while they show
        // the closed state) and with `backendAutoStart` off nothing on the
        // Mac ever records a version — without it the phone is dead against a
        // healthy v47 server for the life of the app process. And it has to
        // run when the gate looks OPEN, because a cached v47 for a server
        // since replaced by an older one is the unsafe direction, and the
        // phone is the surface with no approval UI to catch the result. One
        // loopback GET with a 2 s budget, against a turn that is about to
        // take seconds anyway.
        await backendManager?.refreshServerApiVersion()
        guard chatHost.quickChatServerSupportsAsk(apiVersion: backendManager?.serverApiVersion) else {
            await server?.send(Output(commandId: chat.commandId, payload: OutputPayload(
                stream: chatHost.quickChatUnsupportedServerMessage(apiVersion: backendManager?.serverApiVersion),
                done: true)))
            return
        }
        guard let config, let projectStore,
              let quick = chatHost.quickChat(config: config, projectStore: projectStore, api: api) else {
            // A normal reply, NOT a CommandError: the phone renders an error
            // as a failure, and "no project is open on the Mac" is an
            // answer — same no-project gate the menu bar / LLM Chat sheet use.
            await server?.send(Output(commandId: chat.commandId, payload: OutputPayload(
                stream: chatHost.quickChatNoProjectMessage, done: true)))
            return
        }
        let engine = quick.engine
        guard let sid = UUID(uuidString: engine.currentSessionIDString) else {
            // Unreachable in practice — `quickChat` always lands on a
            // real session — but a CommandError beats a silent hang if a
            // future change to that resolution ever leaves it empty.
            await server?.send(CommandError(commandId: chat.commandId, message: "Could not open your chat on the Mac."))
            return
        }
        // Fold extracted file text into the prompt (mirrors how history was
        // folded server-side under the old transport).
        let message = Self.messageWithFiles(chat.text, files: chat.files)
        // Forward the Mac user's selected provider/model (same source as
        // explore_chat) so a non-Anthropic provider is used instead of the
        // server defaulting to Anthropic → the claude CLI → "not logged in".
        let (model, provider, routeFallback) = MobileExploreBridge.modelAndProvider(
            config: config, mode: "auto_read_only", requiresAgentEngine: engine.usesAgentV2Engine)
        do {
            let commandId = chat.commandId
            // A parked question goes to the phone to be tapped, not left to
            // whoever reaches the Mac. Both arms open and close it the same
            // way — see `beginPhoneApprovals`.
            beginPhoneApprovals(engine: engine, commandId: commandId)
            defer { endPhoneApprovals(engine: engine, commandId: commandId) }
            let reply = try await engine.runExternalTurn(
                message: message,
                skillIds: [],
                attachments: [],
                // Topped up with the project's open issues (see
                // `ChatMobileHost.quickChat`) — this handler can await.
                agentContext: await quick.agentContext(),
                model: model,
                provider: provider,
                // Classified like the Mac's Auto, then clamped server-side to
                // a mode that cannot write (`auto_read_only` — see
                // llm_agent/modes/mode-classify.mjs).
                //
                // It used to send a flat `"ask"`, for a real reason: the phone
                // has no approval UI, so a write-capable mode would park a
                // card nobody could answer. But the server only classifies
                // `auto` — an explicit mode is taken at face value — so "make
                // me a plan" from the phone never reached plan mode at all. It
                // got the ASK persona, which ends by telling the user to go
                // ask in the Code Assistant panel.
                //
                // The pin was right for `execute` and wrong for the rest:
                // plan/assist_plan/review/document are all tool-restricted,
                // and on the Agent engine a plan turn has no save-plan tool —
                // the plan is simply the reply. So they need no confirmation
                // channel, and `execute` still lands on `ask`.
                mode: "auto_read_only",
                permissionMode: nil,
                routeFallback: routeFallback,
                expectedSessionID: sid,
                onProgress: { [weak self] label in
                    guard let self, !self.isMobileCommandCancelled(commandId) else { return }
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
        } catch let error where chatHost.isTurnCancellation(error) {
            // Covers a Mac-side Stop too — same as explore_chat below.
            append(.info, "llmide_chat cancelled: \(chat.commandId.prefix(8))")
            await notifyStoppedOnMac(chat.commandId)
        } catch {
            // Also covers `ExternalTurnError.busy` (a Mac window mid-stream
            // on this same shared engine): a typed, sane CommandError rather
            // than a hang — same as explore_chat's own unhandled-error path.
            guard !isMobileCommandCancelled(chat.commandId) else { return }
            append(.stderr, "llmide_chat failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
            await server?.send(CommandError(commandId: chat.commandId, message: error.localizedDescription))
        }
    }

    /// Proxy an explorer chat turn through a chat engine — the SAME shared
    /// instance the Mac Explorer panel renders when that's safe, or a private
    /// off-screen engine when it isn't (`chatHost.explorerTurnEngine`, whose
    /// Chat implementation is `ExplorerMobileEngineResolver` — see its doc comment: the
    /// shared engine must never be force-switched away from a DIFFERENT
    /// session the Mac is already showing, since that would silently cancel
    /// the Mac user's in-flight turn and yank their screen to an unrelated
    /// chat). Persistence, the synthetic-turn append, and the streamed round
    /// trip all go through the engine's `runExternalTurn`, a 1:1 mirror of the
    /// panel's own `runTurn` — no direct session-store reads/writes here.
    ///
    /// The engine is resolved as LATE as possible — right before
    /// `runExternalTurn`, after every `await` this method does on the way
    /// there (`MobileExploreBridge.buildAgentContext`'s `git` subprocesses in
    /// particular, which can take hundreds of ms to seconds on a large
    /// repo). Code review caught that resolving it any earlier reopens a
    /// version of the exact hijack the explorer engine resolver exists to
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
        guard let chatHost else {
            replyFeatureUnavailable(feature: "Chat", commandId: chat.commandId)
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
        // Project-scoped too: a stale id from another project would otherwise
        // keep chatting in that project's session with THIS project's
        // workspace context (refs, agent context) attached.
        guard chatHost.explorerSession(id: sid, visibleInProject: activeExplorerProjectId) != nil else {
            append(.info, "explore_chat: session \(chat.sessionId.prefix(8)) not found")
            await server?.send(CommandError(commandId: chat.commandId, message: "Session not found on Mac — it may have been deleted. Reload your explorer sessions."))
            return
        }
        var attachments = MobileExploreBridge.attachments(from: chat.files)
        // @file/@folder refs read project files, so they honour the Files switch (re-checked per request).
        let refsAllowed = phoneAccess.isAllowed(.fileBrowse)
        let turnPolicy = MobileExploreBridge.turnPolicy(editAllowed: phoneAccess.isAllowed(.exploreEdit))
        let refs = refsAllowed ? chat.refs : []
        if !refsAllowed, !chat.refs.isEmpty {
            append(.info, "explore_chat: @file refs ignored — \"\(PhoneAccess.fileBrowse.title)\" is off")
        }
        if let root = mobileWorkspaceURL(), !refs.isEmpty {
            // Off main: the reads are phone-driven and can be slow (see attachmentsOffMain).
            let (refAttachments, refErrors) = await MobileWorkspaceSearch.attachmentsOffMain(
                from: refs, workspaceRoot: root)
            attachments.append(contentsOf: refAttachments)
            for err in refErrors { append(.info, "explore_chat: \(err)") }
        }
        let agentMessage = MobileWorkspaceSearch.promptWithRefs(chat.text, refs: refs)
        let (skillMessage, skillIds) = MobileSkillCatalog.resolveMessage(agentMessage, skills: chat.skills)
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
        guard let engine = chatHost.explorerTurnEngine(for: sid, api: api) else {
            append(.info, "explore_chat: could not resolve session \(chat.sessionId.prefix(8))")
            await server?.send(CommandError(commandId: chat.commandId, message: "Could not open that session on your Mac."))
            return
        }
        // Resolved AFTER the engine: a tier route must fit the engine (a v2
        // chat needs an Agent-engine-capable provider).
        let (model, provider, routeFallback) = MobileExploreBridge.modelAndProvider(
            config: config, mode: "auto", requiresAgentEngine: engine.usesAgentV2Engine)
        do {
            let commandId = chat.commandId
            // A parked question goes to the phone to be tapped, not left to
            // whoever reaches the Mac. Both arms open and close it the same
            // way — see `beginPhoneApprovals`.
            beginPhoneApprovals(engine: engine, commandId: commandId)
            defer { endPhoneApprovals(engine: engine, commandId: commandId) }
            let reply = try await engine.runExternalTurn(
                message: skillMessage,
                skillIds: skillIds,
                attachments: attachments,
                agentContext: agentContext,
                model: model,
                provider: provider,
                // Parity with the Mac's own Explorer panel, which sends its
                // picker's mode — usually Auto, which the server classifies.
                // This arm sent nothing, so every turn ran as the server's
                // default (execute): "make me a plan" never reached plan mode,
                // because only `auto` is ever classified.
                mode: turnPolicy.mode,
                // The Mac's permission chip, so a classified execute turn can
                // finish — but ONLY when the user enabled the exploreEdit
                // switch; otherwise the turn is read-only. See turnPolicy.
                permissionMode: turnPolicy.permissionMode,
                routeFallback: routeFallback,
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
        } catch let error where chatHost.isTurnCancellation(error) {
            // Same as llmide_chat: a Mac-side Stop of a phone-driven turn
            // surfaces as URLError.cancelled (streaming) or the wrapped
            // APIError.network shape (buffered fallback), not CancellationError.
            append(.info, "explore_chat cancelled: \(chat.commandId.prefix(8))")
            await notifyStoppedOnMac(chat.commandId)
        } catch {
            guard !isMobileCommandCancelled(chat.commandId) else { return }
            append(.stderr, "code-assist failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
            await server?.send(CommandError(commandId: chat.commandId, message: error.localizedDescription))
        }
    }

    /// Delete an explorer session on behalf of the phone, routed through
    /// whichever engine currently holds it so nothing can persist it back
    /// (see `ChatMobileHost.deleteExplorerSession` for why each step exists).
    /// Refuses a non-Explorer session and an Explorer chat of another
    /// project: the phone sends a bare UUID and only ever listed the active
    /// project's Explorer chats.
    // internal: pinned by MobileExploreScopeTests
    func handleExploreDelete(_ uid: UUID) async {
        guard let chatHost else {
            append(.stderr, "Explore delete: Chat not installed")
            return
        }
        switch await chatHost.deleteExplorerSession(id: uid, visibleInProject: activeExplorerProjectId, api: api) {
        case .notExplorer:
            append(.info, "Explore delete: \(uid.uuidString.prefix(8)) is not an Explorer chat — refused")
        case .otherProject:
            append(.info, "Explore delete: \(uid.uuidString.prefix(8)) belongs to another project — refused")
        case .deleted:
            append(.info, "Explore delete: \(uid.uuidString.prefix(8))")
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

    // internal: shared with the Mobile*Bridge classes (feature folders)
    func append(_ stream: MobileLogLine.Stream, _ text: String) {
        // Capped here so no caller — bridge, server callback, error text — can
        // make one line arbitrarily large; the 5 000-line cap alone bounds the
        // COUNT of lines, not their size.
        logLines.append(.init(text: MobileLogPolicy.capLine(text), stream: stream))
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
    /// A frame that names a command but does not decode (a version skew
    /// between phone and Mac, a field this build does not know) used to be
    /// logged and dropped — and the phone, which has no per-command timeout,
    /// showed its placeholder spinning until the connection died. Answer the
    /// command with an error so it resolves.
    private func replyDecodeFailure(_ data: Data, what: String) {
        struct Envelope: Decodable { let commandId: String? }
        guard let id = (try? decoder.decode(Envelope.self, from: data))?.commandId, !id.isEmpty else { return }
        reply(CommandError(commandId: id,
                           message: "The Mac could not read this \(what). Update LLM-IDE on both devices to matching versions and try again."))
    }

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
                Task {
                    await self?.pushMacStatusIfPaired()
                    // Explorer chats are listed per project, so a project
                    // switch changes what the phone should show.
                    self?.pushExploreSessionListIfPaired()
                }
            }
            .store(in: &mobilePushCancellables)

        autoTaskBridge?.installPushObservers()
        loopBridge?.installPushObservers()
        generationBridge?.installPushObservers()
        activityBridge?.installPushObservers()
        registeredBridges.forEach { $0.bridge.installPushObservers() }
    }

    /// Push a fresh Mac status snapshot when backend or project context changes.
    func onMacEnvironmentChanged() {
        Task { await pushMacStatusIfPaired() }
    }

    private func onMobileClientPaired() {
        phoneSessionGeneration += 1
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
        _ = activityBridge?.handle(type: MobileProtocol.Tag.activityList, data: nil)
        if workspaceChangedWhileUnpaired, let root = mobileWorkspaceURL() {
            workspaceChangedWhileUnpaired = false
            Task { await exploreIndex.refreshWorkspaceIndex(root: root, force: true) }
        }
        Task { await pushMacStatusIfPaired() }
    }

    private func onMobileClientDisconnected() {
        mobileClientPaired = false
        connectedDeviceId = nil
        // A reviewed patch belongs to the session that saw it; nothing may
        // apply it once that phone is gone.
        selfHealBridge?.forgetReviewedPatches()
        // The phone is gone, so these turns end for it, not "on the Mac":
        // mark them cancelled so their catch paths send nothing
        // (`notifyStoppedOnMac`) to a phone that reconnects quickly.
        // Union, not assignment: a command the phone already cancelled is out
        // of `mobileInflightTasks` but its task may still be finishing, and
        // it must keep its flag until that task's own finish prunes it.
        truncatedToolRequestIds.removeAll()
        mobileCancelledCommandIds.formUnion(mobileInflightTasks.keys)
        for entry in mobileInflightTasks.values { entry.task.cancel() }
        mobileInflightTasks.removeAll()
    }

    // MARK: - Mid-turn questions

    /// Start forwarding this turn's parked questions to the phone.
    ///
    /// Paired with `endPhoneApprovals` in a `defer`, by both phone arms. It is
    /// one definition rather than two hand-copied blocks because the two arms
    /// already diverged once on exactly this kind of wiring: the first version
    /// of this channel was added to `llmide_chat` only, so the Explorer chat —
    /// the arm actually bound to a project, where the planning questions come
    /// from — still showed nothing but "Question pending on Mac".
    ///
    /// Skipped when the engine is already busy: `runExternalTurn` is about to
    /// throw `.busy` without running anything, and installing here would
    /// overwrite the single-slot hook of the turn that IS running (and whose
    /// questions must keep reaching its own phone command).
    // internal: pinned by MobilePhoneApprovalHookTests
    func beginPhoneApprovals(engine: any MobileChatTurnEngine, commandId: String) {
        guard !engine.busy else { return }
        phoneApprovalOwners[ObjectIdentifier(engine)] = commandId
        engine.onExternalApproval = { [weak self] approval in
            guard let self else { return }
            Task { await self.sendApprovalToPhone(approval, commandId: commandId, engine: engine) }
        }
    }

    /// Stop forwarding, and take down any card still on the phone: once the
    /// turn is over the requestId is dead server-side, and a question that
    /// can no longer be answered is worse than no question.
    ///
    /// The hook is cleared only if this command still owns it: a command
    /// that was rejected as busy never installed one, and clearing anyway
    /// would silence the running turn's questions on the phone.
    // internal: pinned by MobilePhoneApprovalHookTests
    func endPhoneApprovals(engine: any MobileChatTurnEngine, commandId: String) {
        let key = ObjectIdentifier(engine)
        if phoneApprovalOwners[key] == commandId {
            phoneApprovalOwners.removeValue(forKey: key)
            engine.onExternalApproval = nil
        }
        guard let entry = pendingPhoneApprovals.removeValue(forKey: commandId) else { return }
        Task { [weak self] in
            await self?.server?.send(ApprovalCleared(
                commandId: commandId, requestId: entry.requestId,
                reason: "This turn has finished."))
        }
    }

    /// Mac → phone: a question the turn is parked on.
    private func sendApprovalToPhone(_ approval: AgentV2Approval, commandId: String,
                                     engine: any MobileChatTurnEngine) async {
        // ToolApproval (allow/deny a write) is deliberately NOT forwarded: the
        // phone runs read-only modes, so one should never park — and if one
        // ever did, an allow button on a surface with no diff view is not a
        // decision anyone should be asked to make from a phone.
        if approval.kind == "ToolApproval" {
            // Relayed only when the Mac user switched on "Approve or deny tool and edit requests".
            // Otherwise it stays parked on the Mac exactly as before (the Mac chip's mode decides).
            guard phoneAccess.isAllowed(.toolApprovals) else { return }
            pendingPhoneApprovals[commandId] = (engine, approval.requestId)
            let request = await Task.detached { MobileToolApproval.request(from: approval, commandId: commandId) }.value
            if request.truncated { truncatedToolRequestIds.insert(approval.requestId) }
            await server?.send(request)
            return
        }
        guard approval.kind == "AskUserQuestion", !approval.questions.isEmpty else { return }
        pendingPhoneApprovals[commandId] = (engine, approval.requestId)
        await server?.send(ApprovalRequest(
            commandId: commandId,
            requestId: approval.requestId,
            questions: approval.questions.map { q in
                MobileApprovalQuestion(
                    question: q.question,
                    header: q.header,
                    options: q.options.map { MobileApprovalOption(label: $0.label, description: $0.description) },
                    multiSelect: q.multiSelect)
            }))
    }

    /// Phone → Mac: the user's answers to a parked question.
    ///
    /// Routed to the engine holding the approval rather than a remembered
    /// one: by the time an answer arrives the turn may have moved on, and
    /// `submitApproval` no-ops when the requestId it holds is not this one.
    /// Pure so a test can pin every refusal: the switch must (still) be on, the answer must name the
    /// request this turn is parked on, and that request must be a tool prompt.
    nonisolated static func toolAnswerRefusal(switchOn: Bool, pendingRequestId: String?, pendingKind: String?,
                                              answerRequestId: String) -> String? {
        guard switchOn else { return PhoneAccess.toolApprovals.deniedMessage }
        guard let pendingRequestId, pendingRequestId == answerRequestId, pendingKind == "ToolApproval" else {
            return "That request is no longer open."
        }
        return nil
    }

    /// The ONLY decisions a phone can send for a tool prompt: allow this one call, or deny. Never an
    /// "always allow" project rule and never a mode change (Bypass): those stay desktop-only decisions.
    nonisolated static func phoneToolDecisionAction(allow: Bool) -> String { allow ? "allow" : "deny" }

    private func handleToolApprovalAnswer(_ answer: ToolApprovalAnswer) async {
        let entry = pendingPhoneApprovals[answer.commandId]
        let pending = entry?.engine.parkedApproval
        if let why = Self.toolAnswerRefusal(
            switchOn: phoneAccess.isAllowed(.toolApprovals),
            pendingRequestId: entry.flatMap { $0.requestId == answer.requestId ? pending?.requestId : nil },
            pendingKind: pending?.kind, answerRequestId: answer.requestId) {
            // Refused: the prompt (if any) stays parked on the Mac for its owner to decide.
            await server?.send(ApprovalCleared(commandId: answer.commandId, requestId: answer.requestId, reason: why))
            return
        }
        guard let entry, let pending else { return }
        if answer.allow, truncatedToolRequestIds.contains(answer.requestId) {
            // Denying is always fine; allowing a change that could not be shown in full is not. The
            // prompt stays parked on the Mac for someone who can read all of it.
            await server?.send(ApprovalCleared(
                commandId: answer.commandId, requestId: answer.requestId,
                reason: "That change was too long to review on the phone — approve it on the Mac."))
            return
        }
        truncatedToolRequestIds.remove(answer.requestId)
        append(.info, "tool approval from phone: \(answer.allow ? "allow" : "deny") \(pending.toolName ?? "tool")")
        let submitError = await entry.engine.submitPhoneToolDecision(action: Self.phoneToolDecisionAction(allow: answer.allow))
        pendingPhoneApprovals.removeValue(forKey: answer.commandId)
        await server?.send(ApprovalCleared(commandId: answer.commandId, requestId: answer.requestId,
                                           reason: submitError))
    }

    private func handleApprovalAnswer(_ answer: ApprovalAnswer) async {
        guard let entry = pendingPhoneApprovals[answer.commandId],
              entry.requestId == answer.requestId,
              let pending = entry.engine.parkedApproval,
              pending.requestId == answer.requestId,
              // A TOOL prompt is answered only through `tool_approval_answer` (which checks the switch):
              // this question path posts no action, which the server reads as a deny.
              pending.kind == "AskUserQuestion" else {
            // Already answered, expired, or belongs to another turn. Tell the
            // phone rather than leaving its card up waiting for a reply that
            // is never coming.
            await server?.send(ApprovalCleared(
                commandId: answer.commandId, requestId: answer.requestId,
                reason: "That question is no longer open."))
            return
        }
        let submitError = await entry.engine.submitPhoneApproval(answers: answer.answers)
        pendingPhoneApprovals.removeValue(forKey: answer.commandId)
        // Either it landed (the card should go) or it failed and the state
        // kept its error for the Mac to show; the phone's copy is done either
        // way — a retry belongs to the surface that can see the error.
        await server?.send(ApprovalCleared(
            commandId: answer.commandId, requestId: answer.requestId,
            reason: submitError))
    }

    // MARK: - Paired devices

    /// Bookkeeping after the server rotated the PIN on a successful pairing
    /// (see `onPinConsumed` in `start()`): Settings re-reads the PIN and QR via
    /// `pinGeneration`. The new PIN is live in memory either way; a failed
    /// Keychain write only means the PREVIOUS one comes back at next launch,
    /// which is worth a loud line.
    private func pinDidRotate(persisted: Bool) {
        pinGeneration += 1
        if persisted {
            append(.info, "Pairing PIN rotated — the previous PIN no longer works")
        } else {
            append(.stderr, "Pairing PIN rotated for this session, but the Keychain write failed — the previous PIN returns at next launch")
        }
    }

    func refreshPairedDevices() {
        pairedDevices = pairedDeviceStore.all
    }

    /// Forget a phone. Its token is refused from now on, and if it is the one
    /// connected right now it is told why and dropped.
    func revokeDevice(_ id: String) {
        pairedDeviceStore.revoke(id: id)
        refreshPairedDevices()
        server?.disconnectClient(deviceId: id, code: .revoked,
                                 message: "This device was removed in Settings → Mobile Control on the Mac")
        append(.info, "Revoked paired device \(id.prefix(8))…")
    }

    /// Forget every paired phone: the account that paired them is gone. Each
    /// has to pair with the PIN again. The connected phone is dropped whether
    /// or not it is in the registry: a PIN-only phone has no device id, so a
    /// per-id disconnect would never reach it.
    func revokeAllDevices() {
        let ids = pairedDeviceStore.revokeAll()
        refreshPairedDevices()
        server?.disconnectCurrentClient(code: .revoked,
                                        message: "The Mac signed out of the account this phone was paired with")
        if !ids.isEmpty { append(.info, "Revoked \(ids.count) paired device(s) after an account change") }
        // Revoking tokens alone left the PIN on screen (or in a photo of the
        // QR) valid: an unused PIN would still pair a phone into the NEW
        // account. Retire it the same way a successful pairing does.
        rotatePairingPin()
    }

    /// Retire the current PIN now: the in-memory half is immediate (the very
    /// next `validatePin` sees the new one), the Keychain write runs off the
    /// main actor, and `pinDidRotate` refreshes Settings — the same split as
    /// `onPinConsumed` in `start()`. Safe while the server is stopped too: the
    /// rotated PIN is simply what the next start serves.
    private func rotatePairingPin() {
        let fresh = MobilePin.rotateInMemory()
        Task.detached(priority: .utility) { [weak self] in
            let persisted = (try? MobilePin.persist(fresh)) != nil
            await MainActor.run { [weak self] in self?.pinDidRotate(persisted: persisted) }
        }
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
        guard mobileClientPaired, let chatHost else { return }
        let rows = Self.exploreSummaries(chatHost.explorerSessions(visibleInProject: activeExplorerProjectId))
        reply(ExploreSessionList(sessions: rows))
    }

    /// Chat's session rows → the phone's wire rows (uuid string + epoch seconds).
    private static func exploreSummaries(_ sessions: [MobileChatSessionSummary]) -> [ExploreSessionSummary] {
        sessions.map {
            ExploreSessionSummary(id: $0.id.uuidString,
                                  title: $0.title,
                                  lastUsedAt: $0.lastUsedAt.timeIntervalSince1970)
        }
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
              let dir = chatHost?.explorerSessionsDirectory else { return }
        sessionDirectoryWatcher = RepoFileWatcher(repoRoot: dir, debounce: 1.0) { [weak self] in
            Task { @MainActor in self?.pushExploreSessionListIfPaired() }
        }
    }

    // internal: pinned by MobileInflightTaskTests
    func registerMobileInflightTask(commandId: String,
                                          operation: @escaping @MainActor () async -> Void) {
        mobileInflightTasks[commandId]?.task.cancel()
        mobileCancelledCommandIds.remove(commandId)
        let cid = commandId
        let token = UUID()
        let task = Task.detached(priority: .userInitiated) { @MainActor [weak self] in
            guard let self else { return }
            defer { self.mobileInflightTaskFinished(commandId: cid, token: token) }
            await operation()
        }
        mobileInflightTasks[cid] = MobileInflightTask(token: token, task: task)
    }

    /// Bookkeeping when a registered task ends. A re-registration of the same
    /// commandId cancels the old task, whose `defer` runs AFTER the new one is
    /// stored — so it may only clear the slot if the token is still its own,
    /// or it would orphan the new task (no longer cancellable from the phone).
    private func mobileInflightTaskFinished(commandId: String, token: UUID) {
        if let current = mobileInflightTasks[commandId], current.token != token {
            // A newer task owns this commandId; its own finish cleans up.
            return
        }
        mobileInflightTasks.removeValue(forKey: commandId)
        // The command is over, so its cancelled flag has served its purpose
        // (the catch paths already consulted it). Without this the set grew
        // by one id per phone-side cancel / disconnect for the whole session.
        // Pruned on a later main-actor turn so progress hops the turn already
        // queued still see the flag and stay silent.
        Task { @MainActor [weak self] in
            guard let self, self.mobileInflightTasks[commandId] == nil else { return }
            self.mobileCancelledCommandIds.remove(commandId)
        }
    }

    // internal: pinned by MobileInflightTaskTests
    func cancelMobileInflightTask(commandId: String) {
        // Flag only a command that is actually running: its task's finish
        // prunes the flag again. An id with no task (already finished, or not
        // yet registered — registration clears the flag anyway) would never be
        // pruned and only grow the set.
        if let entry = mobileInflightTasks.removeValue(forKey: commandId) {
            mobileCancelledCommandIds.insert(commandId)
            entry.task.cancel()
        }
        reply(CommandError(commandId: commandId, message: "Cancelled"))
    }

    /// The project Explorer chats are scoped to — the Mac's active project,
    /// same as the Explorer panel (the chat engine's `explorerProjectId`). The phone
    /// lists and creates Explorer chats under it.
    private var activeExplorerProjectId: String? {
        projectStore?.activeProject?.bundle.id
    }

    private func isMobileCommandCancelled(_ commandId: String) -> Bool {
        mobileCancelledCommandIds.contains(commandId)
    }

    /// A phone-driven turn was cancelled from the MAC side (Stop, a session
    /// switch or delete). Without a terminal message the command never gets
    /// `done` or an error on the phone and it spins forever. A phone-side
    /// cancel already answered "Cancelled" (`cancelMobileInflightTask`), so
    /// that case is skipped rather than answered twice.
    private func notifyStoppedOnMac(_ commandId: String) async {
        guard !isMobileCommandCancelled(commandId) else { return }
        await server?.send(CommandError(commandId: commandId, message: "Stopped on the Mac"))
    }

    private func handleLlmIdeCancel(data: Data) {
        guard let m = try? decoder.decode(LlmIdeCancel.self, from: data) else {
            append(.stderr, "llmide_cancel decode failed")
            return
        }
        append(.info, "llmide_cancel \(m.commandId.prefix(8))")
        cancelMobileInflightTask(commandId: m.commandId)
    }

    /// Route the phone's history request onto the quick engine's transcript
    /// — the `.quick` engine's own transcript now IS the phone's chat history
    /// (Chat's session store), not the retired `/kb/agent/ask/history` table
    /// this used to poll. `limit` still bounds the reply size the same way
    /// the old server-side query parameter did.
    private func handleLlmIdeChatHistoryList(data: Data) async {
        struct LimitEnvelope: Decodable { let limit: Int? }
        let limit = max((try? decoder.decode(LimitEnvelope.self, from: data))?.limit ?? 50, 0)
        guard let api, let config, let projectStore else {
            reply(CommandError(commandId: "llmide_chat_history", message: "Backend not configured"))
            return
        }
        guard let chatHost else {
            replyFeatureUnavailable(feature: "Chat", commandId: "llmide_chat_history")
            return
        }
        guard let quick = chatHost.quickChat(config: config, projectStore: projectStore, api: api) else {
            // No project open → no `.quick` session to read; an empty
            // transcript rather than an error, since "no history yet" is a
            // legitimate state (unlike `handleChat`'s no-project decline,
            // this isn't answering a question the user asked).
            reply(LlmIdeChatHistoryReply(messages: []))
            return
        }
        // Tool-result rows are internal turn bookkeeping, not part of the
        // simple back-and-forth the phone renders — `conversationLines`
        // filters them the same way the retired `/kb/agent/ask/history`
        // table (user/assistant rows only) implicitly was.
        let turns = quick.engine.conversationLines
            .suffix(limit)
            .map { ChatTurn(role: $0.role, content: $0.content) }
        reply(LlmIdeChatHistoryReply(messages: turns))
    }

    /// Route the phone's "clear" onto the quick engine's `clearCurrentChat()` — the same
    /// header-trash action the LLM Chat sheet/menu bar use, which also
    /// forgets the chat's server-side session memory. The retired
    /// `clearAgentAskHistory()` wiped the wrong (unread) table.
    private func handleLlmIdeChatHistoryClear() async {
        // Clearing wipes the Mac's quick chat (shared with the menu bar), so it
        // sits behind the same default-OFF switch as every other phone action
        // that changes Mac-side chat state — see `Self.chatDeletionAllowed`.
        guard Self.chatDeletionAllowed({ phoneAccess.isAllowed($0) }) else {
            reply(CommandError(commandId: "llmide_chat_history_clear",
                               message: Self.chatDeletionSwitch.deniedMessage))
            return
        }
        guard let api else {
            reply(CommandError(commandId: "llmide_chat_history_clear", message: "Backend not configured"))
            return
        }
        guard let chatHost else {
            replyFeatureUnavailable(feature: "Chat", commandId: "llmide_chat_history_clear")
            return
        }
        guard let config, let projectStore,
              let quick = chatHost.quickChat(config: config, projectStore: projectStore, api: api) else {
            // No project open → nothing to clear; ack rather than error,
            // mirroring the history-list's no-project behavior above.
            reply(LlmIdeChatHistoryClearAck(ok: true))
            return
        }
        await quick.engine.clearCurrentChat()
        reply(LlmIdeChatHistoryClearAck(ok: true))
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
        guard let chatHost else {
            replyFeatureUnavailable(feature: "Chat", commandId: "explore_rename")
            return
        }
        guard let m = try? decoder.decode(ExploreRenameSession.self, from: data),
              let sid = UUID(uuidString: m.sessionId) else {
            reply(CommandError(commandId: "explore_rename", message: "Session not found on Mac"))
            return
        }
        let trimmed = m.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let title = chatHost.renameExplorerSession(
            id: sid, visibleInProject: activeExplorerProjectId,
            title: trimmed.isEmpty ? "Untitled" : trimmed) else {
            reply(CommandError(commandId: "explore_rename", message: "Session not found on Mac"))
            return
        }
        append(.info, "Explore rename: \(sid.uuidString.prefix(8)) (\(title.count) chars)")
        reply(ExploreSessionRenamed(sessionId: sid.uuidString, title: title))
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

/// A lock-protected `[String]` the manager updates on the main actor and the WebSocket server
/// reads from its own queue when it builds the `Connected` reply.
final class CapabilityBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = MobileControlManager.capabilities(autoTasks: false, loop: false, generation: false)

    var value: [String] {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}

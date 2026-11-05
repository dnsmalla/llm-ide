import Foundation
import UIKit
import SharedProtocol

// MARK: — Shared chat value types

/// One entry in the AI prompt conversation. Shared by both chat stores
/// (`LlmIdeChatStore`, `ExplorerChatStore`) and rendered by `ChatBubble`.
struct ChatMessage: Identifiable, Equatable {
    /// STABLE across a history reload. The id used to be a fresh `UUID()` per
    /// instance, and `loadSharedHistory()` replaces the whole array after every
    /// completed reply — so identical content got a new identity each time and
    /// SwiftUI tore down and rebuilt the entire transcript, losing the scroll
    /// anchor. Server-derived turns key on (index, role, text); locally minted
    /// ones keep a UUID, which is stable for their lifetime.
    let id: String
    let role: Role
    var text: String
    /// Optional image the user attached (shown as a thumbnail in the bubble).
    var imageData: Data? = nil

    enum Role { case user, assistant }

    init(role: Role, text: String, imageData: Data? = nil) {
        self.id = UUID().uuidString
        self.role = role
        self.text = text
        self.imageData = imageData
    }

    /// A turn restored from the server transcript. `index` disambiguates two
    /// identical messages in one conversation.
    init(historyIndex index: Int, role: Role, text: String) {
        self.id = "h\(index):\(role == .assistant ? "a" : "u"):\(text.hashValue)"
        self.role = role
        self.text = text
        self.imageData = nil
    }
}

/// The currently-loaded explorer-chat session and its on-device transcript.
/// Owned by `ExplorerChatStore`; `history` mirrors `LlmIdeChatStore.llmIdeMessages`.
struct ExploreCurrentSession: Equatable {
    let id: String
    var title: String
    var history: [ChatMessage]
}

// MARK: — Shared streaming-chat helpers
//
// Used by both chat stores so the two surfaces stay in lock-step. Each store
// sets its OWN `isStreaming` flag after calling `mintStreamingTurn` — this
// replaces the pre-refactor shared `llmStreaming` flag (a streaming reply on
// one surface no longer disables the send button on the other).

/// Build the text-only history window (prior images/files are never re-sent),
/// append the user turn + an empty assistant placeholder, and mint a commandId
/// into the owning surface's id set. Returns `(commandId, history)` so each
/// caller wraps it in its concrete Codable payload. History window is unified
/// at 10 turns for both surfaces (the server re-caps to its own window).
@discardableResult
func mintStreamingTurn(
    messages: inout [ChatMessage],
    commandIds: inout Set<String>,
    userText: String,
    imageData: Data? = nil
) -> (commandId: String, history: [ChatTurn]) {
    let history = messages.suffix(10).compactMap { m -> ChatTurn? in
        guard !m.text.isEmpty else { return nil }
        return ChatTurn(role: m.role == .assistant ? "assistant" : "user", content: m.text)
    }
    messages.append(ChatMessage(role: .user, text: userText, imageData: imageData))
    messages.append(ChatMessage(role: .assistant, text: ""))
    let id = UUID().uuidString
    commandIds.insert(id)
    return (id, history)
}

func appendToLastAssistant(_ list: inout [ChatMessage], _ chunk: String) {
    if let idx = list.lastIndex(where: { $0.role == .assistant }) {
        list[idx].text += chunk
    } else {
        list.append(ChatMessage(role: .assistant, text: chunk))
    }
}

/// Replace (not append) the trailing assistant bubble — used for live status
/// lines and the final full reply from Mac code-assist.
func setLastAssistant(_ list: inout [ChatMessage], _ text: String) {
    if let idx = list.lastIndex(where: { $0.role == .assistant }) {
        list[idx].text = text
    } else {
        list.append(ChatMessage(role: .assistant, text: text))
    }
}

func removeTrailingEmptyAssistant(_ list: inout [ChatMessage]) {
    if let last = list.last, last.role == .assistant, last.text.isEmpty {
        list.removeLast()
    }
}

// MARK: — ConnectionService

/// Owns the WebSocket connection lifecycle: pairing, heartbeat, reconnect, and
/// the inbound receive loop that dispatches frames to the per-feature stores.
/// The three feature stores (`LlmIdeChatStore`, `ExplorerChatStore`,
/// `AutoTaskStore`) each hold a weak reference back to this service to send
/// outbound frames, and register themselves here on init so the receive loop
/// can route inbound frames to the right store.
@MainActor
final class ConnectionService: ObservableObject {
    @Published var connectionStatus: ConnectionStatus = .disconnected {
        didSet {
            // The Mac cancels a phone's turns when its connection drops, so a question or tool prompt
            // raised on the old connection can never be answered — a card left up would accept a tap
            // and look approved when nothing was.
            if connectionStatus != .connected, oldValue == .connected {
                llmIdeStore?.clearPendingPrompts()
                explorerStore?.clearPendingPrompts()
            }
        }
    }
    @Published var errorMessage: String?
    /// What the paired Mac says it serves (`Connected.capabilities`), or nil before the first
    /// `connected` frame of this pairing. A Mac that sends no list is a pre-handshake Mac and
    /// gets `Capability.legacy`, so screens for newer features hide instead of spinning.
    @Published private(set) var macCapabilities: Set<String>?
    @Published private(set) var macProtocolVersion: Int?
    /// The transport the chat + approvals slice speaks (spec phase 4). It is v2 (today's socket, through
    /// `V2HostConnection`) unless negotiation found a v1 host. The other stores still use `sendEncodable` (v2).
    var host: HostConnection { v1Client ?? v2Host }
    /// 1 while a Host API v1 connection is up, 2 otherwise. Views gate the v2-only screens on it (Plan 4 decision 6).
    @Published private(set) var hostApiVersion = 2
    private(set) lazy var v2Host: V2HostConnection = {
        let h = V2HostConnection(service: self)
        h.onEvent = { [weak self] in self?.route($0) }
        return h
    }()
    private var v1Client: HostApiV1Client?
    /// The v1 client still in hello/auth, so a Disconnect, Forget or new connect can close it (final review I3).
    private var connectingV1: HostApiV1Client?

    /// Host API v1 `read` (chat list + one chat, read-only). Sends only through the v1 client, never v2.
    @Published private(set) var readState = HostApiReadState()
    private(set) lazy var reads: HostApiReadController = {
        let r = HostApiReadController(host: { [weak self] in self?.v1Client })
        r.onChange = { [weak self] in self?.readState = $0 }
        return r
    }()
    /// True only on a v1 connection whose host granted `read`. Not optimistic, unlike `supports`.
    var servesV1Read: Bool { HostApiReadGate.isOn(apiVersion: hostApiVersion, capabilities: macCapabilities) }

    /// Whether to offer a feature. Optimistic until the first handshake so tabs don't flicker
    /// in after launch; after it, exactly what the Mac advertised.
    func supports(_ capability: String) -> Bool {
        macCapabilities?.contains(capability) ?? true
    }

    enum ConnectionStatus {
        case disconnected, connecting, connected
    }

    // Weak back-references to the feature stores. The app (`@StateObject`) owns
    // them; these let the receive loop dispatch inbound frames. Always non-nil
    // while the app runs.
    weak var llmIdeStore: LlmIdeChatStore?
    weak var explorerStore: ExplorerChatStore?
    weak var autoTaskStore: AutoTaskStore?
    weak var loopStore: LoopStore?
    weak var macStatusStore: MacStatusStore?
    weak var generationStore: GenerationStore?
    weak var activityStore: ActivityFeedStore?
    weak var usageStore: UsageStore?
    weak var projectsStore: ProjectsStore?
    weak var selfHealStore: SelfHealStore?
    weak var sourceControlStore: SourceControlStore?
    weak var filesStore: FilesStore?
    weak var issuesStore: IssuesStore?
    /// Set at app launch so `Connected.deviceName` can update persisted pairing info.
    weak var connectionStore: ConnectionStore?

    /// True while the app is running against `DemoResponder` instead of a real
    /// Mac — see DemoMode.swift for why this exists. Published because
    /// `ContentView` gates the whole paired UI on it: in demo mode there is no
    /// saved device, so `connectionStore.hasDevice` is false and would send the
    /// user straight back to the pairing screen.
    @Published private(set) var isDemo = false
    /// Non-nil exactly while `isDemo`. Answers outbound frames locally.
    private var demoResponder: DemoResponder?

    private var webSocketTask: URLSessionWebSocketTask?
    /// ONE session for the app's lifetime. Creating a `URLSession` per connect
    /// attempt leaked it (and its delegate queue) every time, and the reconnect
    /// loop can run indefinitely — see `scheduleReconnect`.
    private let session = URLSession(configuration: .default)
    /// Fires when a socket opens but the pairing handshake never completes.
    private var pairingDeadlineTask: Task<Void, Never>?
    private static let pairingTimeout: TimeInterval = 12
    private var reconnectAttempt = 0
    /// Bumped whenever the active socket is replaced or torn down. Receive
    /// callbacks capture this at registration time and ignore stale results so
    /// a cancelled connection cannot kill a newer one (the pair→disconnect loop).
    private var connectionGeneration = 0
    private var reconnectTask: Task<Void, Never>?

    /// True after `closeConnection()` until the next `connectDirect(...)` call.
    /// Distinguishes an intentional close (don't auto-reconnect) from an
    /// unexpected drop (auto-reconnect is correct) — `ContentView`'s
    /// launch/appear check reads this before reconnecting.
    private(set) var userClosed = false

    private var directIP: String?
    private var directPort: Int = 3006
    private var directPIN: String?

    // Heartbeat — detects silently dead connections (Wi-Fi drop, Mac sleep).
    private var heartbeatTask: Task<Void, Never>?
    private var lastAck: Date = .distantPast
    private static let heartbeatInterval: TimeInterval = 10
    private static let heartbeatTimeout: TimeInterval = 25

    // MARK: — Connection

    func connectDirect(ip: String, port: Int = 3006, pin: String) {
        userClosed = false
        // Already live against this exact Mac: nothing to do. The credential
        // is deliberately not part of the comparison — after pairing the PIN
        // is empty on both sides and the token lives in the store, and tearing
        // down a healthy socket to present the same credential again gains
        // nothing.
        if connectionStatus == .connected, directIP == ip, directPort == port {
            return
        }
        // Re-pointing at a DIFFERENT Mac: every store still holds the previous
        // one's transcripts, session ids and status. Left in place, the first
        // explorer send goes out with a sessionId that doesn't exist on the new
        // Mac, and the dashboard shows the old machine's data.
        if let previous = directIP, previous != ip {
            resetStoresForNewDevice()
        }
        directIP   = ip
        directPort = port
        directPIN  = pin
        // Clear the previous attempt's reason: the receive-failure path only
        // writes when `errorMessage == nil`, so a stale value silenced every
        // later failure — and an unchanged value never re-triggers the
        // banner's onChange either.
        errorMessage = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        invalidateSocket()
        connectionStatus = .connecting
        let generation = connectionGeneration
        // Spec "Compatibility with MobileProtocol v2": try host.hello first, but only at a v1 endpoint that is
        // actually known. Port 3016 is never assumed (Plan 4 decision 1).
        var negotiation = HostApiNegotiation()
        if !isDemo, let endpoint = connectionStore?.hostApiEndpoint,
           negotiation.handle(.start(v1Endpoint: true)) == .openV1AndHello {
            connectV1(endpoint, ip: ip, port: port, pin: pin, generation: generation)
            return
        }
        connectV2(ip: ip, port: port, pin: pin, generation: generation)
    }

    /// Today's v2 connect, unchanged: URL, Pairing frame, pairing deadline, receive loop.
    private func connectV2(ip: String, port: Int, pin: String, generation: Int) {
        // Built with URLComponents, and the PIN is NOT in the URL: it only ever
        // travels in the `Pairing` frame below. The query copy was redundant
        // (the Mac stopped reading it) and put the pairing secret into
        // CFNetwork/URLSession diagnostics for free.
        var components = URLComponents()
        components.scheme = "ws"
        // An IPv6 literal must be bracketed in a URL authority; URLComponents
        // does not add them, so `fe80::1` would fail to build.
        components.host = ip.contains(":") && !ip.hasPrefix("[") ? "[\(ip)]" : ip
        components.port = port
        components.path = "/ws"
        guard let url = components.url else {
            errorMessage = "Invalid connection details"
            connectionStatus = .disconnected
            return
        }
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()
        // Message-based pairing: the first frame after the WS opens must be a
        // Pairing message. A phone that already holds a token from an earlier
        // pairing presents that (no PIN travels); otherwise the PIN, together
        // with this phone's id and name so the Mac issues a token in its
        // Connected{deviceName, token} reply (handled in handleMessage →
        // "connected"). A refusal is AuthFailed{message} (→ "auth_failed").
        let token = connectionStore?.deviceToken ?? ""
        let pairing = Pairing(
            pin: token.isEmpty ? pin : "",
            token: token.isEmpty ? nil : token,
            deviceId: connectionStore?.deviceId,
            deviceName: UIDevice.current.name
        )
        if let data = try? JSONEncoder().encode(pairing),
           let str = String(data: data, encoding: .utf8) {
            sendTextFrame(str)
        } else {
            errorMessage = "Failed to encode pairing message"
            disconnect(clearDirect: true)
            return
        }
        startPairingDeadline(generation: generation)
        receiveMessage(generation: generation)
    }

    private func connectV1(_ endpoint: HostApiEndpoint, ip: String, port: Int, pin: String, generation: Int) {
        // wss without a stored pin is refused here, before any socket opens, and never falls back to v2.
        let trust: HostApiTrustEvaluating?
        do { trust = try HostApiPinning.trust(for: endpoint, pin: connectionStore?.hostApiPin) } catch {
            return handleV1Refusal(HostApiPinning.missingPin)
        }
        let client = HostApiV1Client(
            config: .init(clientName: UIDevice.current.name,
                          clientVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"),
            makeSocket: { URLSessionHostApiSocket(url: endpoint.url, trust: trust) })
        client.onEvent = { [weak self] in self?.route($0) }
        let token = connectionStore?.hostApiToken ?? ""
        let credential: HostCredential = token.isEmpty ? .pin(pin) : .token(token)
        connectingV1 = client
        Task { @MainActor [weak self] in
            let outcome = await client.connect(credential)
            if self?.connectingV1 === client { self?.connectingV1 = nil }
            guard let self, generation == self.connectionGeneration else { client.close(); return }
            switch outcome {
            case .ready(let hello, let newToken):
                self.v1Client = client
                self.hostApiVersion = 1
                self.macProtocolVersion = hello.protocolVersion
                self.macCapabilities = client.capabilities
                self.errorMessage = nil
                self.reconnectAttempt = 0
                self.connectionStore?.updateDeviceName(hello.hostName)
                if let newToken {
                    self.directPIN = nil
                    if self.connectionStore?.saveHostApiToken(newToken) == false {
                        self.errorMessage = "Connected, but the pairing token could not be saved to the Keychain — you will need to pair again next time."
                    }
                }
                self.portWatch?.stop()
                self.portWatch = nil
                self.connectionStatus = .connected
            case .notV1:
                // A v1-only phone must not try v2 with nothing to present: the Mac's auth_failed would wipe
                // the v1 token over a transient outage (Mac restarting). Back off and retry v1 instead.
                let hasV2Credential = !(self.connectionStore?.deviceToken ?? "").isEmpty || !pin.isEmpty
                guard HostApiNegotiation.fallsBackToV2(hasV1Token: !token.isEmpty, hasV2Credential: hasV2Credential,
                                                       pinned: endpoint.isTLS) else {
                    // The host may have bound another port in 3016…3025: listen for its TXT while retrying.
                    self.watchForMovedHostApiPort()
                    return self.handleV1Refusal(HostApiRejection(
                        replyTo: nil, code: "host_unreachable",
                        message: "Couldn't reach the Mac. Retrying…", retryable: true))
                }
                self.connectV2(ip: ip, port: port, pin: pin, generation: generation)
            case .refused(let r):
                self.handleV1Refusal(r)
            }
        }
    }

    /// Bonjour while a pinned v1 host is unreachable. A TXT carrying the stored pin moves the stored port, and
    /// the next backoff retry dials it (`hostApiEndpoint` is read on every connect).
    private var portWatch: DeviceDiscovery?
    private func watchForMovedHostApiPort() {
        guard portWatch == nil, connectionStore?.hostApiPort ?? 0 > 0 else { return }
        let watch = DeviceDiscovery()
        watch.onResolve = { [weak self] device in
            self?.connectionStore?.refreshHostApiPort(host: device.host, offer: device.hostApiOffer)
        }
        watch.start()
        portWatch = watch
    }

    /// A v1 host refused. Retryable (throttle, busy, unreachable) keeps the pairing and backs off. Only a
    /// non-retryable `auth_failed` (the device is not paired) clears the credentials and returns to pairing;
    /// any other refusal keeps the pairing and stops, showing the host's message.
    private func handleV1Refusal(_ r: HostApiRejection) {
        errorMessage = r.message.isEmpty ? "Your Mac refused the connection." : r.message
        if r.retryable {
            reconnectAttempt = max(reconnectAttempt, 1)
            invalidateSocket()
            connectionStatus = .disconnected
            scheduleReconnect(retryAfterMs: r.retryAfterMs)
            return
        }
        guard HostApiNegotiation.clearsCredentials(r) else { return closeConnection() }
        directPIN = nil
        connectionStore?.clearCredentials()
        disconnect(clearDirect: true)
    }

    /// Transport events → app state and the chat store.
    private func route(_ event: HostEvent) {
        switch event {
        case .capabilities(let caps):
            macCapabilities = caps
            if !servesV1Read { reads.reset() }   // `read` revoked: clear what is on screen now
            llmIdeStore?.handle(event)
        case .disconnected(let reason):
            guard hostApiVersion == 1 else { return }
            if !reason.retryable { return handleV1Refusal(reason) }
            if errorMessage == nil { errorMessage = "Disconnected from the Mac. Retrying…" }
            // v1 has no replay: no event for a turn on the old session can arrive, so end them all now.
            llmIdeStore?.handleChatError()
            invalidateSocket()
            connectionStatus = .disconnected
            scheduleReconnect(retryAfterMs: reason.retryAfterMs)
        case .resync:
            llmIdeStore?.handle(event)
            if servesV1Read { Task { await reads.refresh() } }
        case .event, .progress:
            llmIdeStore?.handle(event)
        }
    }

    /// TCP can connect while the handshake never completes — Mac app up but
    /// its server stopped, a half-open NAT path, a wedged main actor. The
    /// heartbeat watchdog only arms AFTER `connected`, so without this the app
    /// sat in "Connecting…" forever with nothing to time it out.
    private func startPairingDeadline(generation: Int) {
        pairingDeadlineTask?.cancel()
        pairingDeadlineTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.pairingTimeout * 1_000_000_000))
            guard let self, !Task.isCancelled,
                  generation == self.connectionGeneration,
                  self.connectionStatus != .connected else { return }
            self.errorMessage = "The Mac didn't answer the pairing request. Check that LLM-IDE is running and Mobile Control is started."
            self.invalidateSocket()
            self.connectionStatus = .disconnected
            self.scheduleReconnect()
        }
    }

    /// Wipe every mirrored surface so a newly paired Mac starts from a blank
    /// slate. Also the single place the two "Forget this Mac" call sites use.
    func resetStoresForNewDevice() {
        llmIdeStore?.resetForNewDevice()
        explorerStore?.resetForNewDevice()
        autoTaskStore?.resetForNewDevice()
        loopStore?.resetForNewDevice()
        macStatusStore?.resetForNewDevice()
        generationStore?.resetForNewDevice()
        activityStore?.resetForNewDevice()
        usageStore?.resetForNewDevice()
        projectsStore?.resetForNewDevice()
        selfHealStore?.resetForNewDevice()
        sourceControlStore?.resetForNewDevice()
        filesStore?.resetForNewDevice()
        issuesStore?.resetForNewDevice()
        // The next Mac may serve a different feature set; forget this one's until it says.
        macCapabilities = nil
        macProtocolVersion = nil
    }

    /// Enter demo mode: no socket, no network, no stored credential. Drives
    /// the REAL handshake — the pairing frame goes to `DemoResponder`, whose
    /// `connected` reply walks the same `handleMessage` path a Mac's would, so
    /// the heartbeat, the stores and the status banner all run their normal
    /// code. Left by `disconnect()` / `closeConnection()` like any connection.
    func startDemo() {
        userClosed = false
        reconnectTask?.cancel()
        reconnectTask = nil
        invalidateSocket()
        // A previous real pairing may have left transcripts and session ids in
        // the stores; the demo must not appear to inherit that Mac's data.
        resetStoresForNewDevice()
        errorMessage = nil
        directIP = nil
        directPIN = nil
        isDemo = true
        demoResponder = DemoResponder(emit: { [weak self] frame in
            self?.handleMessage(frame)
        })
        connectionStatus = .connecting
        let pairing = Pairing(pin: "demo", token: nil, deviceId: nil,
                              deviceName: UIDevice.current.name)
        if let data = try? JSONEncoder().encode(pairing),
           let str = String(data: data, encoding: .utf8) {
            sendTextFrame(str)
        }
    }

    func disconnect() { disconnect(clearDirect: true) }

    /// Close the socket but keep the saved pairing (`directIP`/`directPort`/
    /// `directPIN`) so a later `connectDirect` call — e.g. from a Reconnect
    /// action within this session — can re-establish the link without
    /// re-pairing. Sets `userClosed` so `ContentView`'s auto-reconnect does
    /// not immediately undo this. Callers must NOT pair this with
    /// `connectionStore.clear()` the way `disconnect()`'s UI call sites do —
    /// that would defeat the point of keeping the pairing.
    func closeConnection() {
        userClosed = true
        // Reset the backoff counter too: an intentional close shouldn't make
        // the next manual Reconnect inherit whatever delay a prior failed
        // auto-retry run had climbed to (up to 30s — see scheduleReconnect).
        reconnectAttempt = 0
        disconnect(clearDirect: false)
    }

    private func disconnect(clearDirect: Bool) {
        reconnectTask?.cancel()
        reconnectTask = nil
        portWatch?.stop()
        portWatch = nil
        // Demo mode has no socket to close and nothing to reconnect to, so it
        // is torn down here rather than in invalidateSocket() — which also runs
        // on the reconnect path, where dropping the responder would strand the
        // user on a dead screen.
        isDemo = false
        demoResponder = nil
        if clearDirect { directIP = nil; directPIN = nil }
        llmIdeStore?.handleChatError()
        explorerStore?.handleChatError()
        invalidateSocket()
        connectionStatus = .disconnected
    }

    /// Cancel heartbeat + WebSocket and invalidate in-flight receive loops.
    private func invalidateSocket() {
        connectionGeneration += 1
        heartbeatTask?.cancel()
        heartbeatTask = nil
        pairingDeadlineTask?.cancel()
        pairingDeadlineTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        v1Client?.close()
        v1Client = nil
        connectingV1?.close()
        connectingV1 = nil
        hostApiVersion = 2
        reads.reset()
        v2Host.connectionEnded()
    }

    // MARK: — Heartbeat

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        lastAck = Date()
        heartbeatTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.heartbeatInterval) * 1_000_000_000)
                guard let self, !Task.isCancelled else { return }
                guard self.connectionStatus == .connected else { continue }
                if Date().timeIntervalSince(self.lastAck) > Self.heartbeatTimeout {
                    // Demo mode has no socket that can die: `DemoResponder`
                    // is in-process and answers every heartbeat. The only way
                    // to exceed the timeout here is the app having been
                    // suspended in the background, so the gap is elapsed
                    // wall-clock, not a dead peer — and tearing down on it
                    // STRANDED the user. `scheduleReconnect` needs
                    // `directIP`, which the demo deliberately has none of, so
                    // it returns immediately; `ContentView` meanwhile keeps
                    // showing the home screen (it routes on `isDemo`) and
                    // both of its recovery paths skip demo on purpose. The
                    // result was a live-looking screen with nothing behind
                    // it and no way back — which an App Store reviewer who
                    // backgrounds the app for half a minute would hit.
                    if self.isDemo {
                        self.lastAck = Date()
                        continue
                    }
                    // Connection is silently dead — force a reconnect.
                    self.invalidateSocket()
                    self.connectionStatus = .disconnected
                    self.scheduleReconnect()
                    return
                }
                self.sendRaw(["type": "heartbeat"])
            }
        }
    }

    // MARK: — Sending (used by the feature stores)

    /// Encode and send any Codable outbound message over the WebSocket. Single
    /// send path for every simple command (explore*, autoTask*): silent no-op
    /// when disconnected or when the payload won't encode (both indicate a
    /// programming error; the caller's local state is unaffected). Streaming-
    /// chat senders (`sendLlmideChat`/`sendExploreChat`) keep their own error
    /// handling and use `sendTextFrame` directly.
    @discardableResult
    func sendEncodable<T: Encodable>(
        _ payload: T,
        userFacing: Bool = false,
        onSendFailure: ((String) -> Void)? = nil
    ) -> Bool {
        guard canSendV2(userFacing: userFacing) else { return false }
        guard let data = try? JSONEncoder().encode(payload),
              let str = String(data: data, encoding: .utf8) else {
            if userFacing {
                errorMessage = "Couldn't encode the request — try again."
            }
            return false
        }
        sendTextFrame(str, userFacing: userFacing, onSendFailure: onSendFailure)
        return true
    }

    /// sendEncodable's guard, shared with `V2HostConnection`, which sends frames it has already encoded.
    private func canSendV2(userFacing: Bool) -> Bool {
        guard connectionStatus == .connected, webSocketTask != nil || isDemo else {
            if userFacing {
                errorMessage = connectionStatus == .connecting
                    ? "Still connecting to your Mac — wait for Live status, then try again."
                    : "Not connected to your Mac — reconnect from Settings."
            }
            return false
        }
        return true
    }

    @discardableResult
    func sendV2Frame(_ data: Data, userFacing: Bool = false) -> Bool {
        guard canSendV2(userFacing: userFacing) else { return false }
        sendTextFrame(String(decoding: data, as: UTF8.self), userFacing: userFacing)
        return true
    }

    /// Send a pre-encoded JSON string over the WebSocket. Single send path for
    /// both dict-based messages (`sendRaw`) and Codable-encoded frames
    /// (`Pairing`, `LlmIdeChat`, `ExploreChat`).
    func sendTextFrame(
        _ string: String,
        userFacing: Bool = false,
        onSendFailure: ((String) -> Void)? = nil
    ) {
        // Demo mode: answer locally instead of writing to a socket. Placed
        // ahead of the task guard because there IS no task — every send would
        // otherwise fail with "not connected".
        if isDemo {
            demoResponder?.handle(string)
            return
        }
        guard let task = webSocketTask else {
            if userFacing {
                errorMessage = "Not connected to your Mac — reconnect from Settings."
            }
            return
        }
        task.send(.string(string)) { [weak self] err in
            if err != nil {
                Task { @MainActor in
                    guard let self else { return }
                    let message = "Couldn't reach your Mac — check the connection and try again."
                    if userFacing { self.errorMessage = message }
                    onSendFailure?(message)
                }
            }
        }
    }

    private func sendRaw(_ msg: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { return }
        sendTextFrame(str)
    }

    // MARK: — Receive loop + dispatch

    private func receiveMessage(generation: Int) {
        guard generation == connectionGeneration, let task = webSocketTask else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, generation == self.connectionGeneration else { return }
                switch result {
                case .success(let msg):
                    switch msg {
                    case .string(let str):
                        self.handleMessage(str)
                    case .data(let data):
                        if let str = String(data: data, encoding: .utf8) {
                            self.handleMessage(str)
                        }
                    @unknown default: break
                    }
                case .failure(let error):
                    guard generation == self.connectionGeneration else { return }
                    // Report BEFORE scheduleReconnect flips the status back to
                    // .connecting: without a message every failure mode looked
                    // identical to "still connecting", forever.
                    if self.errorMessage == nil {
                        self.errorMessage = Self.describeFailure(error, attempt: self.reconnectAttempt)
                    }
                    self.invalidateSocket()
                    self.connectionStatus = .disconnected
                    self.scheduleReconnect()
                    return
                }
                self.receiveMessage(generation: generation)
            }
        }
    }

    /// Dispatch one inbound frame to the owning concern: connection-level
    /// events (`connected`/`heartbeat_ack`/`auth_failed`) are handled here;
    /// feature frames are forwarded to the matching store. Streaming-chat
    /// `output`/`error` frames are routed by commandId — each chat store
    /// checks its own commandId set, so a reply lands in exactly one surface.
    private func handleMessage(_ str: String) {
        guard let data = str.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        let type = json["type"] as? String ?? ""
        switch type {
        case "connected":
            pairingDeadlineTask?.cancel()
            pairingDeadlineTask = nil
            connectionStatus = .connected
            errorMessage = nil
            reconnectAttempt = 0
            // The demo issues no token and must not write a device name to
            // UserDefaults — nothing about a fake Mac may outlive the session.
            if let connected = try? JSONDecoder().decode(Connected.self, from: data) {
                macProtocolVersion = connected.protocolVersion ?? 1
                macCapabilities = connected.capabilities.map(Set.init) ?? MobileProtocol.Capability.legacy
            }
            if !isDemo, let connected = try? JSONDecoder().decode(Connected.self, from: data) {
                connectionStore?.updateDeviceName(connected.deviceName)
                // First pairing: the Mac traded our PIN for a token. Keep it;
                // the PIN we just used is rotated on the Mac and is now dead.
                if let token = connected.token, !token.isEmpty {
                    directPIN = nil
                    if connectionStore?.saveToken(token) == false {
                        // Connected for now, but nothing to reconnect with: the
                        // Mac has already rotated the PIN we used. Say so
                        // instead of failing silently on the next reconnect.
                        errorMessage = "Connected, but the pairing token could not be saved to the Keychain — you will need to pair again next time."
                    }
                }
            }
            startHeartbeat()
        case "heartbeat_ack":
            lastAck = Date()
        case "auth_failed":
            // Wrong PIN / throttled / locked out — reconnecting is pointless.
            // Prefer the Mac's own wording (it distinguishes a wrong PIN from a
            // lockout); fall back to the generic hint.
            let failure = try? JSONDecoder().decode(AuthFailed.self, from: data)
            let reason = failure?.message
            errorMessage = (reason?.isEmpty == false ? reason : nil)
                ?? "Wrong PIN. Check the 6-digit code in LLM-IDE → Settings → Mobile Control on your Mac."
            // `retryable` = the Mac refused without examining the PIN (rate
            // limit / lockout). Discarding a possibly-CORRECT PIN there would
            // force a needless re-pair, so keep it and let the user retry.
            // Absent field (older Mac) = treat as a genuine wrong PIN.
            if failure?.retryable == true {
                // Keep the pairing AND keep trying: `.wait`/`.lockedOut` do not
                // charge another failure, so an auto-retry can't extend the
                // penalty, and the common "typo, then the right PIN" case heals
                // itself instead of stranding the user on a message that says
                // "try again" while nothing does.
                // Never retry immediately (attempt 0 has zero delay): the Mac is
                // refusing during a penalty window, so hammering it just spins.
                // Floor at 1 so the 2 s / 1.5x (cap 30 s) schedule applies and
                // keep growing across consecutive refusals.
                reconnectAttempt = max(reconnectAttempt, 1)
                invalidateSocket()
                connectionStatus = .disconnected
                scheduleReconnect()
                return
            }
            directPIN = nil
            // Drop the persisted credentials too — a stale PIN (Mac changed
            // its PIN across a reinstall/update) or a token the Mac no longer
            // knows (revoked, registry reset) would otherwise be re-sent on
            // every auto-connect forever. Clears `hasDevice` so `ContentView`
            // routes back to `ConnectView` for a fresh pairing.
            connectionStore?.clearCredentials()
            disconnect(clearDirect: true)
        case "disconnected":
            // The Mac closed THIS connection on purpose and said why. Unlike a
            // dropped socket, blind reconnecting is wrong for two of the three
            // reasons: a revoked token will only be refused again, and racing
            // the phone that replaced us would just bounce both phones.
            let notice = try? JSONDecoder().decode(Disconnected.self, from: data)
            errorMessage = notice?.message ?? "The Mac closed the connection."
            switch notice?.code {
            case .revoked:
                directPIN = nil
                connectionStore?.clearCredentials()
                disconnect(clearDirect: true)
            case .replaced:
                userClosed = true
                disconnect(clearDirect: false)
            case .stopped, .none:
                // Mobile Control was stopped on the Mac — keep the pairing and
                // retry with backoff, exactly like a dropped socket.
                invalidateSocket()
                connectionStatus = .disconnected
                scheduleReconnect()
            }
        case "explore_session_list", "explore_session_history", "explore_session_created", "explore_session_renamed":
            explorerStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "explore_search_reply":
            if let reply = try? JSONDecoder().decode(ExploreSearchReply.self, from: data) {
                explorerStore?.handleSearchReply(reply)
            }
        case "explore_skill_list_reply":
            if let reply = try? JSONDecoder().decode(ExploreSkillListReply.self, from: data) {
                explorerStore?.handleSkillSearchReply(reply)
            }
        case "auto_task_state", "auto_task_history_reply", "auto_task_ack",
             "auto_task_logs_reply", "auto_task_setup_reply":
            autoTaskStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "loop_state", "loop_ack", "loop_history_reply":
            loopStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "mac_capabilities":
            // The Mac's Phone access switches changed mid-session.
            if let update = try? JSONDecoder().decode(MacCapabilities.self, from: data) {
                macCapabilities = Set(update.capabilities)
                llmIdeStore?.handle(.capabilities(macCapabilities ?? []))
            }
        case "files_listing", "files_file":
            filesStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "issues_state", "issue_detail":
            issuesStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "scm_state", "scm_diff_result":
            sourceControlStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "selfheal_state", "selfheal_diff_result":
            selfHealStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "project_state":
            projectsStore?.handleInbound(type: "project_state", data: data)
        case "usage_state":
            usageStore?.handleInbound(type: "usage_state", data: data)
        case "activity_state":
            activityStore?.handleInbound(type: "activity_state", data: data)
        case "generation_options", "generation_result", "llmdoc_listing", "llmdoc_file":
            generationStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "mac_status":
            macStatusStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "llmide_chat_history_reply", "llmide_chat_history_clear_ack":
            v2Host.receive(type: json["type"] as? String ?? "", json: json, data: data)
        case "approval_request", "approval_cleared", "tool_approval_request":
            // Both surfaces can be parked on a question; each store checks the
            // frame's commandId against its own, exactly as with `output`.
            let type = json["type"] as? String ?? ""
            v2Host.receive(type: type, json: json, data: data)
            explorerStore?.handleInbound(type: type, data: data)
        case "output":
            let commandId = json["commandId"] as? String
            // Each store independently checks commandId membership; only the
            // owning store appends/resets. (commandId is in at most one set.)
            v2Host.receive(type: "output", json: json, data: data)
            if let payload = json["payload"] as? [String: Any] {
                explorerStore?.handleOutput(commandId: commandId, payload: payload)
            }
        case "error":
            if let err = try? JSONDecoder().decode(CommandError.self, from: data) {
                let cid = err.commandId
                if err.message != "Cancelled" {
                    if let cid, cid.hasPrefix("loop_") {
                        loopStore?.handleCommandError(err.message)
                    } else if let cid, cid.hasPrefix("gen_") || cid == "generation_run" {
                        generationStore?.handleCommandError(err.message, commandId: cid)
                    } else if let cid, cid.hasPrefix("auto_task") {
                        autoTaskStore?.handleCommandError(err.message, commandId: cid)
                    } else if let cid, cid.hasPrefix("explore_") {
                        explorerStore?.handleSessionCommandError(err.message, commandId: cid)
                    } else {
                        errorMessage = err.message
                    }
                }
                // The chat slice ends its own turns (V2HostConnection → chat.error; the store checks ownership).
                // The explorer branches are the old chain's other two arms, unchanged.
                v2Host.receive(type: MobileProtocol.Tag.error, json: json, data: data)
                if let cid, llmIdeStore?.ownsCommand(cid) != true, explorerStore?.ownsCommand(cid) == true {
                    explorerStore?.handleChatError(commandId: cid)
                } else if cid == nil {
                    explorerStore?.handleChatError()
                }
            }
        default:
            break
        }
    }

    /// Human-readable cause for a dropped/failed socket. Distinguishes the
    /// two cases users actually hit (Mac unreachable vs. network gone) and says
    /// that retrying is happening, so a spinner is never the only feedback.
    static func describeFailure(_ error: Error, attempt: Int) -> String {
        let suffix = attempt > 0 ? " Retrying…" : ""
        let code = (error as NSError).code
        switch code {
        case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorTimedOut:
            return "Couldn't reach the Mac. Check it's awake, on the same network, and Mobile Control is started.\(suffix)"
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost:
            return "Network connection lost.\(suffix)"
        default:
            return "Disconnected from the Mac.\(suffix)"
        }
    }

    private func scheduleReconnect(retryAfterMs: Int? = nil) {
        // Only the address is required: after the first pairing the PIN is
        // gone (the Mac rotated it) and the token in `ConnectionStore` is the
        // credential `connectDirect` presents. Requiring `directPIN` here
        // silently killed every in-session retry after pairing.
        guard let ip = directIP else { return }
        let pin = directPIN ?? ""
        guard reconnectTask == nil else { return }
        // Show "connecting" rather than a false "disconnected" while auto-retrying.
        connectionStatus = .connecting
        let port = directPort
        // First retry is immediate, then back off.
        let delay = HostApiBackoff.delayMs(attempt: reconnectAttempt, retryAfterMs: retryAfterMs)
        reconnectAttempt += 1
        reconnectTask = Task { @MainActor in
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            }
            guard !Task.isCancelled, self.directIP != nil else { return }
            self.reconnectTask = nil
            self.connectDirect(ip: ip, port: port, pin: pin)
        }
    }
}

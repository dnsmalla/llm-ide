import Foundation
import SharedProtocol

// MARK: — Shared chat value types

/// One entry in the AI prompt conversation. Shared by both chat stores
/// (`LlmIdeChatStore`, `ExplorerChatStore`) and rendered by `ChatBubble`.
struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let role: Role
    var text: String
    /// Optional image the user attached (shown as a thumbnail in the bubble).
    var imageData: Data? = nil

    enum Role { case user, assistant }
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
    @Published var connectionStatus: ConnectionStatus = .disconnected
    @Published var errorMessage: String?

    enum ConnectionStatus {
        case disconnected, connecting, connected
    }

    // Weak back-references to the feature stores. The app (`@StateObject`) owns
    // them; these let the receive loop dispatch inbound frames. Always non-nil
    // while the app runs.
    weak var llmIdeStore: LlmIdeChatStore?
    weak var explorerStore: ExplorerChatStore?
    weak var autoTaskStore: AutoTaskStore?
    weak var macStatusStore: MacStatusStore?
    /// Set at app launch so `Connected.deviceName` can update persisted pairing info.
    weak var connectionStore: ConnectionStore?

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
        if connectionStatus == .connected,
           directIP == ip, directPort == port, directPIN == pin {
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
        // Pairing{pin} message. The Mac replies Connected{deviceName} (handled
        // in handleMessage → "connected") or AuthFailed{message} (→ "auth_failed",
        // which stops retrying).
        if let data = try? JSONEncoder().encode(Pairing(pin: pin)),
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
        macStatusStore?.resetForNewDevice()
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
        guard connectionStatus == .connected, webSocketTask != nil else {
            if userFacing {
                errorMessage = connectionStatus == .connecting
                    ? "Still connecting to your Mac — wait for Live status, then try again."
                    : "Not connected to your Mac — reconnect from Settings."
            }
            return false
        }
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

    /// Send a pre-encoded JSON string over the WebSocket. Single send path for
    /// both dict-based messages (`sendRaw`) and Codable-encoded frames
    /// (`Pairing`, `LlmIdeChat`, `ExploreChat`).
    func sendTextFrame(
        _ string: String,
        userFacing: Bool = false,
        onSendFailure: ((String) -> Void)? = nil
    ) {
        guard let task = webSocketTask else {
            if userFacing {
                errorMessage = "Not connected to your Mac — reconnect from Settings."
            }
            return
        }
        task.send(.string(string)) { [weak self] err in
            if let err {
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
            if let connected = try? JSONDecoder().decode(Connected.self, from: data) {
                connectionStore?.updateDeviceName(connected.deviceName)
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
                reconnectAttempt = 0
                invalidateSocket()
                connectionStatus = .disconnected
                scheduleReconnect()
                return
            }
            directPIN = nil
            // Drop the persisted PIN too: if it's stale (Mac changed its PIN
            // across a reinstall/update), auto-connect and manual pre-fill
            // would otherwise re-send it forever. Clears `hasDevice` so
            // `ContentView` routes back to `ConnectView` for a fresh entry.
            connectionStore?.clearSavedPIN()
            disconnect(clearDirect: true)
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
        case "auto_task_state", "auto_task_history_reply", "auto_task_ack", "auto_task_logs_reply":
            autoTaskStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "mac_status":
            macStatusStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "llmide_chat_history_reply", "llmide_chat_history_clear_ack":
            llmIdeStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "output":
            let commandId = json["commandId"] as? String
            if let payload = json["payload"] as? [String: Any] {
                // Each store independently checks commandId membership; only the
                // owning store appends/resets. (commandId is in at most one set.)
                llmIdeStore?.handleOutput(commandId: commandId, payload: payload)
                explorerStore?.handleOutput(commandId: commandId, payload: payload)
            }
        case "error":
            if let err = try? JSONDecoder().decode(CommandError.self, from: data) {
                let cid = err.commandId
                if err.message != "Cancelled" {
                    if let cid, cid.hasPrefix("auto_task") {
                        autoTaskStore?.handleCommandError(err.message, commandId: cid)
                    } else if let cid, cid.hasPrefix("explore_") {
                        explorerStore?.handleSessionCommandError(err.message, commandId: cid)
                    } else {
                        errorMessage = err.message
                    }
                }
                if let cid, llmIdeStore?.ownsCommand(cid) == true {
                    llmIdeStore?.handleChatError(commandId: cid)
                } else if let cid, explorerStore?.ownsCommand(cid) == true {
                    explorerStore?.handleChatError(commandId: cid)
                } else if cid == nil {
                    llmIdeStore?.handleChatError()
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

    private func scheduleReconnect() {
        guard let ip = directIP, let pin = directPIN else { return }
        guard reconnectTask == nil else { return }
        // Show "connecting" rather than a false "disconnected" while auto-retrying.
        connectionStatus = .connecting
        let port = directPort
        // First retry is immediate, then back off.
        let delay = reconnectAttempt == 0
            ? 0
            : min(2_000 * Int(pow(1.5, Double(reconnectAttempt - 1))), 30_000)
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

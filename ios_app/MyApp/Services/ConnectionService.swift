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
    private var reconnectAttempt = 0
    /// Bumped whenever the active socket is replaced or torn down. Receive
    /// callbacks capture this at registration time and ignore stale results so
    /// a cancelled connection cannot kill a newer one (the pair→disconnect loop).
    private var connectionGeneration = 0
    private var reconnectTask: Task<Void, Never>?

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
        if connectionStatus == .connected,
           directIP == ip, directPort == port, directPIN == pin {
            return
        }
        directIP   = ip
        directPort = port
        directPIN  = pin
        reconnectTask?.cancel()
        reconnectTask = nil
        invalidateSocket()
        connectionStatus = .connecting
        let generation = connectionGeneration
        guard let encoded = pin.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "ws://\(ip):\(port)/ws?pin=\(encoded)") else {
            errorMessage = "Invalid connection details"
            connectionStatus = .disconnected
            return
        }
        webSocketTask = URLSession(configuration: .default).webSocketTask(with: url)
        webSocketTask?.resume()
        // Message-based pairing: the first frame after the WS opens must be a
        // Pairing{pin} message. The Mac replies Connected{deviceName} (handled
        // in handleMessage → "connected") or AuthFailed{message} (→ "auth_failed",
        // which stops retrying). The ?pin= query is no longer required by the Mac
        // but is left in the URL harmlessly to minimize churn.
        if let data = try? JSONEncoder().encode(Pairing(pin: pin)),
           let str = String(data: data, encoding: .utf8) {
            sendTextFrame(str)
        } else {
            errorMessage = "Failed to encode pairing message"
            disconnect(clearDirect: true)
        }
        receiveMessage(generation: generation)
    }

    func disconnect() { disconnect(clearDirect: true) }

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
            print("❌ sendEncodable failed: not connected (status=\(connectionStatus))")
            if userFacing {
                errorMessage = connectionStatus == .connecting
                    ? "Still connecting to your Mac — wait for Live status, then try again."
                    : "Not connected to your Mac — reconnect from Settings."
            }
            return false
        }
        guard let data = try? JSONEncoder().encode(payload),
              let str = String(data: data, encoding: .utf8) else {
            print("❌ sendEncodable failed: encoding error")
            if userFacing {
                errorMessage = "Couldn't encode the request — try again."
            }
            return false
        }
        print("📤 sendEncodable: \(str.prefix(80))...")
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
            print("❌ sendTextFrame: no webSocketTask")
            if userFacing {
                errorMessage = "Not connected to your Mac — reconnect from Settings."
            }
            return
        }
        print("📤 Sending \(string.count) bytes via WebSocket")
        task.send(.string(string)) { [weak self] err in
            if let err {
                print("❌ WebSocket send error: \(err.localizedDescription)")
                Task { @MainActor in
                    guard let self else { return }
                    let message = "Couldn't reach your Mac — check the connection and try again."
                    if userFacing { self.errorMessage = message }
                    onSendFailure?(message)
                }
            } else {
                print("✅ Message sent successfully")
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
                case .failure:
                    guard generation == self.connectionGeneration else { return }
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
            print("❌ handleMessage: invalid JSON: \(str.prefix(100))")
            return
        }
        let type = json["type"] as? String ?? ""
        print("📨 iOS received type='\(type)': \(str.prefix(100))...")
        switch type {
        case "connected":
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
            // Wrong PIN — reconnecting with the same PIN is pointless.
            errorMessage = "Wrong PIN. Check the 6-digit code in LLM-IDE → Settings → Mobile Control on your Mac."
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

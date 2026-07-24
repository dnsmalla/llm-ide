import Foundation
import UIKit
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

    private var webSocketTask: URLSessionWebSocketTask?
    private var targetDevice: String?
    private var reconnectAttempt = 0

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
        directIP   = ip
        directPort = port
        directPIN  = pin
        disconnect(clearDirect: false)   // cancel old socket first
        targetDevice = "direct"          // then restore (disconnect clears it only when clearDirect=true)
        connectionStatus = .connecting
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
        receiveMessage()
    }

    func disconnect() { disconnect(clearDirect: true) }

    private func disconnect(clearDirect: Bool) {
        if clearDirect { directIP = nil; directPIN = nil }
        heartbeatTask?.cancel()
        heartbeatTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        connectionStatus = .disconnected
        targetDevice = nil
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
                    self.webSocketTask?.cancel(with: .goingAway, reason: nil)
                    self.webSocketTask = nil
                    self.connectionStatus = .disconnected
                    self.scheduleReconnect()
                    return
                }
                self.sendRaw(["type": "heartbeat"])
            }
        }
    }

    // MARK: — Commands

    /// Tell the Mac to stop streaming (sent during disconnect/forget). Screen
    /// streaming was removed with the remote-desktop body, but this is still
    /// sent by SettingsView's "Forget this Mac" and the toolbar's Disconnect
    /// for a clean teardown, so it is retained.
    func stopViewing() {
        sendRaw(["type": "stop_viewing"])
    }

    // MARK: — Sending (used by the feature stores)

    /// Encode and send any Codable outbound message over the WebSocket. Single
    /// send path for every simple command (explore*, autoTask*): silent no-op
    /// when disconnected or when the payload won't encode (both indicate a
    /// programming error; the caller's local state is unaffected). Streaming-
    /// chat senders (`sendLlmideChat`/`sendExploreChat`) keep their own error
    /// handling and use `sendTextFrame` directly.
    func sendEncodable<T: Encodable>(_ payload: T) {
        guard connectionStatus == .connected,
              let data = try? JSONEncoder().encode(payload),
              let str = String(data: data, encoding: .utf8) else { return }
        sendTextFrame(str)
    }

    /// Send a pre-encoded JSON string over the WebSocket. Single send path for
    /// both dict-based messages (`sendRaw`) and Codable-encoded frames
    /// (`Pairing`, `LlmIdeChat`, `ExploreChat`).
    func sendTextFrame(_ string: String) {
        guard let task = webSocketTask else { return }
        task.send(.string(string)) { [weak self] err in
            if let err {
                Task { @MainActor in self?.errorMessage = err.localizedDescription }
            }
        }
    }

    private func sendRaw(_ msg: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { return }
        sendTextFrame(str)
    }

    // MARK: — Receive loop + dispatch

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            Task { @MainActor in
                switch result {
                case .success(let msg):
                    switch msg {
                    case .string(let str):
                        self?.handleMessage(str)
                    case .data(let data):
                        // Only text (JSON) frames are used now; the binary JPEG
                        // screen-stream branch was removed with the remote-desktop body.
                        if let str = String(data: data, encoding: .utf8) {
                            self?.handleMessage(str)
                        }
                    @unknown default: break
                    }
                case .failure:
                    self?.webSocketTask?.cancel(with: .normalClosure, reason: nil)
                    self?.webSocketTask = nil
                    self?.connectionStatus = .disconnected
                    self?.scheduleReconnect()
                    return
                }
                self?.receiveMessage()
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
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch json["type"] as? String ?? "" {
        case "connected":
            connectionStatus = .connected
            errorMessage = nil
            reconnectAttempt = 0
            startHeartbeat()
        case "heartbeat_ack":
            lastAck = Date()
        case "auth_failed":
            // Wrong PIN — reconnecting with the same PIN is pointless.
            errorMessage = "Wrong PIN. Check the 6-digit code shown in the agent's terminal on your Mac."
            directPIN = nil
            disconnect(clearDirect: true)
        case "explore_session_list", "explore_session_history", "explore_session_created":
            explorerStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "auto_task_state", "auto_task_history_reply", "auto_task_ack":
            autoTaskStore?.handleInbound(type: json["type"] as? String ?? "", data: data)
        case "output":
            let commandId = json["commandId"] as? String
            if let payload = json["payload"] as? [String: Any] {
                // Each store independently checks commandId membership; only the
                // owning store appends/resets. (commandId is in at most one set.)
                llmIdeStore?.handleOutput(commandId: commandId, payload: payload)
                explorerStore?.handleOutput(commandId: commandId, payload: payload)
            }
        case "error":
            // errorMessage is a shared, shell-level surface (stays here). The
            // streaming-flag reset + empty-placeholder cleanup is delegated to
            // each chat store, mirroring the pre-refactor blanket reset.
            if let payload = json["payload"] as? [String: Any],
               let msg = payload["message"] as? String {
                errorMessage = msg
                llmIdeStore?.handleChatError()
                explorerStore?.handleChatError()
            }
        default:
            break
        }
    }

    private func scheduleReconnect() {
        guard let ip = directIP, let pin = directPIN else { return }
        // Show "connecting" rather than a false "disconnected" while auto-retrying.
        connectionStatus = .connecting
        let port = directPort
        // First retry is immediate, then back off.
        let delay = reconnectAttempt == 0
            ? 0
            : min(2_000 * Int(pow(1.5, Double(reconnectAttempt - 1))), 30_000)
        reconnectAttempt += 1
        Task { @MainActor in
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            }
            if self.directIP != nil { self.connectDirect(ip: ip, port: port, pin: pin) }
        }
    }
}

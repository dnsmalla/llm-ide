import Foundation
import UIKit
import SharedProtocol

/// One entry in the AI prompt conversation.
struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let role: Role
    var text: String
    /// Optional image the user attached (shown as a thumbnail in the bubble).
    var imageData: Data? = nil

    enum Role { case user, assistant }
}

@MainActor
final class ControlService: ObservableObject {
    @Published var connectionStatus: ConnectionStatus = .disconnected
    @Published var errorMessage: String?
    @Published var screenImage: UIImage?
    @Published var messages: [ChatMessage] = []
    /// Separate transcript for the llm-ide chat, so it never mixes with the
    /// on-device LLM ("AI") panel that also uses `messages`.
    @Published var llmIdeMessages: [ChatMessage] = []
    @Published var llmStreaming: Bool = false
    /// Transient confirmation of one-shot actions (open/close/menu); auto-clears.
    @Published var actionStatus: String?

    /// Command ids whose streamed reply belongs to the llm-ide transcript.
    private var llmIdeCommandIds: Set<String> = []
    private var actionStatusTask: Task<Void, Never>?

    // Frame ordering — decodes happen off-main and can finish out of order.
    private var receivedSeq: UInt64 = 0
    private var shownSeq: UInt64 = 0

    enum ConnectionStatus {
        case disconnected, connecting, connected
    }

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
        screenImage  = nil
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
                    self.screenImage = nil
                    self.connectionStatus = .disconnected
                    self.scheduleReconnect()
                    return
                }
                self.sendRaw(["type": "heartbeat"])
            }
        }
    }

    // MARK: — Commands

    func startViewing() {
        guard let targetDevice, connectionStatus == .connected else { return }
        sendRaw(["type": "start_viewing", "targetDevice": targetDevice])
    }

    func stopViewing() {
        sendRaw(["type": "stop_viewing"])
        screenImage = nil
    }

    func sendRemoteInput(action: [String: Any]) {
        guard let targetDevice, connectionStatus == .connected else { return }
        sendRaw(["type": "remote_input", "targetDevice": targetDevice, "action": action])
    }

    func launchApp(name: String) {
        guard let targetDevice, connectionStatus == .connected else { return }
        sendRaw(["type": "launch_app", "targetDevice": targetDevice,
                 "payload": ["appName": name]])
    }

    func sendKey(_ key: String, modifiers: [String] = []) {
        sendRemoteInput(action: ["type": "key", "key": key, "modifiers": modifiers])
    }

    /// Types a whole string on the Mac in one action (voice dictation, paste).
    func sendText(_ text: String) {
        sendRemoteInput(action: ["type": "text", "text": text])
    }

    func sendPrompt(_ text: String) {
        guard let targetDevice, connectionStatus == .connected else { return }
        messages.append(ChatMessage(role: .user, text: text))
        messages.append(ChatMessage(role: .assistant, text: ""))
        llmStreaming = true
        sendRaw([
            "type": "command",
            "targetDevice": targetDevice,
            "command": [
                "id": UUID().uuidString,
                "type": "prompt",
                "payload": ["text": text],
                "timestamp": ISO8601DateFormatter().string(from: Date())
            ] as [String: Any]
        ])
    }

    func stopPrompt() {
        guard let targetDevice, connectionStatus == .connected else { return }
        sendRaw([
            "type": "command",
            "targetDevice": targetDevice,
            "command": [
                "id": UUID().uuidString,
                "type": "stop",
                "payload": [:] as [String: Any]
            ] as [String: Any]
        ])
    }

    func clearChat() {
        messages.removeAll()
    }

    // MARK: — llm-ide control

    /// Display name of the llm-ide Mac app. This is what `open -a`, AppleScript
    /// `tell application`, and System Events `process` all resolve by — the
    /// executable is `LlmIdeMac` but the app presents itself as "LLM IDE".
    static let llmIdeAppName = "LLM IDE"

    /// Ask llm-ide's agent a question. The agent on the Mac forwards it to the
    /// llm-ide localhost API and the reply streams back through the same
    /// `output`/`done` path as `sendPrompt`, so it lands in `messages`.
    func sendLlmideChat(_ text: String, image: (data: Data, mediaType: String)? = nil) {
        guard targetDevice != nil, connectionStatus == .connected else { return }
        // Prior turns become history for the agent (server re-caps to 10).
        // History is text-only — prior images aren't re-sent.
        let history = llmIdeMessages.suffix(10).compactMap { m -> ChatTurn? in
            guard !m.text.isEmpty else { return nil }
            return ChatTurn(role: m.role == .assistant ? "assistant" : "user", content: m.text)
        }
        llmIdeMessages.append(ChatMessage(role: .user, text: text, imageData: image?.data))
        llmIdeMessages.append(ChatMessage(role: .assistant, text: ""))
        llmStreaming = true
        let id = UUID().uuidString
        llmIdeCommandIds.insert(id)
        let img = image.map { ChatImage(mediaType: $0.mediaType, data: $0.data.base64EncodedString()) }
        let chat = LlmIdeChat(commandId: id, text: text, history: history, image: img)
        if let data = try? JSONEncoder().encode(chat),
           let str = String(data: data, encoding: .utf8) {
            sendTextFrame(str)
        } else {
            errorMessage = "Failed to encode chat message"
            disconnect(clearDirect: true)
        }
    }

    func clearLlmIdeChat() {
        llmIdeMessages.removeAll()
    }

    /// Open the llm-ide Mac app. With a `tab` it navigates there via the
    /// `llmide://` deep link (which also launches the app if needed).
    func openLlmIde(tab: String? = nil) {
        if let tab {
            sendCommand(type: "open_url", payload: ["url": "llmide://\(tab)"])
        } else {
            launchApp(name: Self.llmIdeAppName)
        }
    }

    /// Quit the llm-ide Mac app.
    func closeLlmIde() {
        sendCommand(type: "quit_app", payload: ["appName": Self.llmIdeAppName])
    }

    /// Click a menu-bar path in an app, e.g. ["File", "New"].
    func clickMenu(app: String, path: [String]) {
        sendCommand(type: "menu_click", payload: ["appName": app, "path": path])
    }

    /// Wrap a command in the `{type:"command", command:{…}}` envelope and send.
    private func sendCommand(type: String, payload: [String: Any], id: String = UUID().uuidString) {
        guard let targetDevice, connectionStatus == .connected else { return }
        sendRaw([
            "type": "command",
            "targetDevice": targetDevice,
            "command": [
                "id": id,
                "type": type,
                "payload": payload,
                "timestamp": ISO8601DateFormatter().string(from: Date())
            ] as [String: Any]
        ])
    }

    /// Show a short-lived confirmation (e.g. "Launched LlmIdeMac"), auto-clearing.
    private func setActionStatus(_ message: String) {
        actionStatus = message
        actionStatusTask?.cancel()
        actionStatusTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled else { return }
            self?.actionStatus = nil
        }
    }

    // MARK: — Internal

    /// Send a pre-encoded JSON string over the WebSocket. Single send path for
    /// both dict-based messages (`sendRaw`) and Codable-encoded frames (`Pairing`).
    private func sendTextFrame(_ string: String) {
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

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            Task { @MainActor in
                switch result {
                case .success(let msg):
                    switch msg {
                    case .string(let str):
                        self?.handleMessage(str)
                    case .data(let data):
                        if data.count >= 2 && data[0] == 0xFF && data[1] == 0xD8 {
                            self?.decodeFrame(data)
                        } else if let str = String(data: data, encoding: .utf8) {
                            self?.handleMessage(str)
                        }
                    @unknown default: break
                    }
                case .failure:
                    self?.webSocketTask?.cancel(with: .normalClosure, reason: nil)
                    self?.webSocketTask = nil
                    self?.screenImage = nil
                    self?.connectionStatus = .disconnected
                    self?.scheduleReconnect()
                    return
                }
                self?.receiveMessage()
            }
        }
    }

    /// Decode JPEG off the main thread (at ~20fps, main-thread decoding janks
    /// the UI); a sequence check drops frames that finish out of order.
    private func decodeFrame(_ data: Data) {
        receivedSeq += 1
        let seq = receivedSeq
        Task.detached(priority: .userInitiated) { [weak self] in
            guard let image = UIImage(data: data),
                  let cgImage = image.cgImage else { return }
            // Force decompression now, not at render time
            _ = cgImage.dataProvider
            await MainActor.run {
                guard let self, seq > self.shownSeq else { return }
                self.shownSeq = seq
                self.screenImage = image
            }
        }
    }

    private func handleMessage(_ str: String) {
        guard let data = str.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch json["type"] as? String ?? "" {
        case "connected":
            connectionStatus = .connected
            errorMessage = nil
            reconnectAttempt = 0
            startHeartbeat()
            startViewing()
        case "heartbeat_ack":
            lastAck = Date()
        case "auth_failed":
            // Wrong PIN — reconnecting with the same PIN is pointless.
            errorMessage = "Wrong PIN. Check the 6-digit code shown in the agent's terminal on your Mac."
            directPIN = nil
            disconnect(clearDirect: true)
        case "ack":
            // One-shot actions (launch/quit/open/menu) carry a human message but
            // no `started` flag — surface those as a transient confirmation.
            // Skip prompt acks (started:true) and input acks (no message).
            if let payload = json["payload"] as? [String: Any],
               let msg = payload["message"] as? String,
               (payload["started"] as? Bool) != true {
                setActionStatus(msg)
            }
        case "output":
            let commandId = json["commandId"] as? String
            let toLlmIde = commandId.map { llmIdeCommandIds.contains($0) } ?? false
            if let payload = json["payload"] as? [String: Any] {
                if let chunk = payload["stream"] as? String, !chunk.isEmpty {
                    appendAssistantChunk(chunk, toLlmIde: toLlmIde)
                }
                if let done = payload["done"] as? Bool, done {
                    llmStreaming = false
                    if let id = commandId { llmIdeCommandIds.remove(id) }
                }
            }
        case "error":
            if let payload = json["payload"] as? [String: Any],
               let msg = payload["message"] as? String {
                errorMessage = msg
                llmStreaming = false
                // Drop the empty "…" placeholder left by a failed chat turn.
                removeTrailingEmptyAssistant(&messages)
                removeTrailingEmptyAssistant(&llmIdeMessages)
            }
        default:
            break
        }
    }

    private func appendAssistantChunk(_ chunk: String, toLlmIde: Bool) {
        if toLlmIde { appendToLastAssistant(&llmIdeMessages, chunk) }
        else { appendToLastAssistant(&messages, chunk) }
    }

    private func appendToLastAssistant(_ list: inout [ChatMessage], _ chunk: String) {
        if let idx = list.lastIndex(where: { $0.role == .assistant }) {
            list[idx].text += chunk
        } else {
            list.append(ChatMessage(role: .assistant, text: chunk))
        }
    }

    private func removeTrailingEmptyAssistant(_ list: inout [ChatMessage]) {
        if let last = list.last, last.role == .assistant, last.text.isEmpty {
            list.removeLast()
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

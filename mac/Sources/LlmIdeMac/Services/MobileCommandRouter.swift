import Foundation
import Observation

/// Routes commands from chat UI to mobile agent on :3006.
/// Handles voice transcripts, typing feedback, and quick actions.
@MainActor
@Observable
final class MobileCommandRouter {
    let agentPort: Int = 3006
    private let baseURL: String

    init(agentPort: Int = 3006) {
        self.baseURL = "http://127.0.0.1:\(agentPort)"
    }

    /// Send a command to mobile agent. Command types:
    /// - "voice" - speech transcription: `{text: "transcribed text"}`
    /// - "typing" - real-time typing feedback: `{text: "partial input"}`
    /// - "send" - final message sent: `{text: "message"}`
    /// - "mobile" - quick action: `{action: "scroll", direction: "up"}`
    func sendCommand(_ type: String, payload: [String: Any] = [:]) async {
        guard let url = URL(string: "\(baseURL)/mobile/command") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["type": type]
        body.merge(payload) { _, new in new }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 2.0
            let session = URLSession(configuration: config)

            let (_, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                print("Mobile command failed: \(http.statusCode)")
            }
        } catch {
            print("Failed to send mobile command: \(error.localizedDescription)")
        }
    }

    /// Send voice transcript to mobile.
    func sendVoiceTranscript(_ text: String) async {
        await sendCommand("voice", payload: ["text": text])
    }

    /// Notify mobile of real-time typing feedback.
    func notifyTyping(_ text: String) async {
        // Debounce: only send every 500ms to avoid flooding
        await sendCommand("typing", payload: ["text": text])
    }

    /// Send final message being sent to LLM.
    func sendMessage(_ text: String) async {
        await sendCommand("send", payload: ["text": text])
    }

    /// Execute a quick action (scroll, back, tap, etc).
    func executeQuickAction(_ action: String, params: [String: String] = [:]) async {
        var payload: [String: Any] = ["action": action]
        params.forEach { payload[$0] = $1 }
        await sendCommand("mobile", payload: payload)
    }

    /// Scroll mobile screen up.
    func scrollUp() async {
        await executeQuickAction("scroll", params: ["direction": "up"])
    }

    /// Scroll mobile screen down.
    func scrollDown() async {
        await executeQuickAction("scroll", params: ["direction": "down"])
    }

    /// Go back on mobile.
    func goBack() async {
        await executeQuickAction("back")
    }

    /// Go home on mobile.
    func goHome() async {
        await executeQuickAction("home")
    }

    /// Simulate tap on mobile screen.
    func tap() async {
        await executeQuickAction("tap")
    }

    /// Take screenshot on mobile.
    func takeScreenshot() async {
        await executeQuickAction("screenshot")
    }

    /// Check if agent is reachable with a simple health check.
    func healthCheck() async -> Bool {
        guard let url = URL(string: "\(baseURL)/info") else { return false }

        var request = URLRequest(url: url)
        request.timeoutInterval = 1.0

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1.0
        let session = URLSession(configuration: config)

        do {
            let (_, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                return true
            }
        } catch {
            return false
        }
        return false
    }
}

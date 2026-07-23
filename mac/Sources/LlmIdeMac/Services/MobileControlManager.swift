import AppKit
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

    private var server: MobileWebSocketServer?
    private var advertiser: MobileBonjourAdvertiser?
    private let maxLogLines = 5_000

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

        // PIN: create-or-read. Falls back to a placeholder only if the
        // Keychain is unavailable — pairing would then fail loudly at the
        // device rather than silently storing the wrong secret.
        let pin = (try? MobilePin.ensure()) ?? MobilePin.read() ?? "000000"

        let name = Self.deviceName()
        let server = MobileWebSocketServer(
            port: MobileProtocol.defaultPort,
            deviceName: name,
            validatePin: { candidate in candidate == pin },
            onInbound: { [weak self] data in Task { @MainActor in self?.handleInbound(data) } },
            onLog: { [weak self] line in
                Task { @MainActor [weak self] in self?.append(.info, line) }
            }
        )
        do {
            try server.start()
        } catch {
            lastError = "Failed to start mobile server: \(error.localizedDescription)"
            append(.stderr, "ERROR: \(error.localizedDescription)")
            status = .crashed(exitCode: -1)
            return
        }
        self.server = server

        let advertiser = MobileBonjourAdvertiser(name: name, port: MobileProtocol.defaultPort)
        advertiser.start()
        self.advertiser = advertiser

        status = .running
    }

    /// Tear down the native server and Bonjour advertisement. Idempotent —
    /// safe to call from the Quit hook, the Stop button, or a failed restart.
    func stop() {
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
    /// The SharedProtocol structs use `let type = "…"` with a synthesized
    /// `init(from:)` that does NOT validate the discriminator value, and
    /// several explorer structs (`ExploreListSessions`/`ExploreNewSession`)
    /// are empty — so a greedy sequential `decode` lets the first empty
    /// struct swallow every payload (it succeeds on any JSON carrying a
    /// string `type`). To keep `ExploreLoadSession`/`ExploreNewSession`/
    /// `ExploreDeleteSession`/`ExploreChat` reachable, we decode a one-field
    /// `{type}` envelope ONCE and `switch` on it — mirroring the iOS receive
    /// loop. Each case then decodes its full message type and runs the
    /// existing handler body verbatim.
    private func handleInbound(_ data: Data) {
        struct Envelope: Decodable { let type: String }
        guard let env = try? JSONDecoder().decode(Envelope.self, from: data) else {
            let preview = String(data: data, encoding: .utf8) ?? "<\(data.count) bytes>"
            append(.info, "Unhandled inbound (no type): \(preview)")
            return
        }

        switch env.type {
        case "llmide_chat":
            // Phase 3/4 chat proxy — must keep working alongside explorer ops.
            if let chat = try? JSONDecoder().decode(LlmIdeChat.self, from: data) {
                append(.info, "Chat: \(chat.text.prefix(40))")
                Task { await handleChat(chat) }
            }
        case "explore_list_sessions":
            // `ChatSessionStore` is Mac-local JSON keyed by `ChatScope.explorer`.
            let rows = ChatSessionStore.list(for: .explorer).map {
                ExploreSessionSummary(id: $0.id.uuidString,
                                      title: $0.title,
                                      lastUsedAt: $0.lastUsedAt.timeIntervalSince1970)
            }
            append(.info, "Explore list: \(rows.count) session(s)")
            Task { await server?.send(ExploreSessionList(sessions: rows)) }
        case "explore_load_session":
            if let m = try? JSONDecoder().decode(ExploreLoadSession.self, from: data),
               let s = ChatSessionStore.load(id: UUID(uuidString: m.sessionId) ?? UUID()) {
                // `CodeAssistTurn` → `ChatTurn`: drop the client-only `id`, surface
                // the role as its raw string ("user"/"assistant").
                let turns = s.history.map { ChatTurn(role: $0.role.rawValue, content: $0.content) }
                append(.info, "Explore load: \(s.id.uuidString.prefix(8))")
                Task { await server?.send(ExploreSessionHistory(sessionId: s.id.uuidString,
                                                                title: s.title,
                                                                history: turns)) }
            }
        case "explore_new_session":
            let s = ChatSession(scope: .explorer, title: "New chat")
            ChatSessionStore.save(s)
            append(.info, "Explore new: \(s.id.uuidString.prefix(8))")
            Task { await server?.send(ExploreSessionCreated(sessionId: s.id.uuidString)) }
        case "explore_delete_session":
            if let m = try? JSONDecoder().decode(ExploreDeleteSession.self, from: data) {
                if let uid = UUID(uuidString: m.sessionId) {
                    ChatSessionStore.delete(id: uid)
                    append(.info, "Explore delete: \(uid.uuidString.prefix(8))")
                }
            }
        case "explore_chat":
            if let chat = try? JSONDecoder().decode(ExploreChat.self, from: data) {
                append(.info, "Explore chat in \(chat.sessionId.prefix(8))")
                Task { await handleExploreChat(chat) }
            }
        default:
            append(.info, "Unhandled inbound type: \(env.type)")
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
            await server?.send(Output(commandId: chat.commandId,
                                      payload: OutputPayload(stream: reply, done: true)))
        } catch {
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
        let history = chat.history.map {
            LlmIdeAPIClient.CodeAssistTurn(role: .init(rawValue: $0.role) ?? .user, content: $0.content)
        }
        do {
            let resp = try await api.codeAssistStream(
                message: chat.text,
                language: nil,
                history: history,
                attachments: [],
                skills: [],
                onProgress: { [weak self] label in self?.append(.info, "code-assist: \(label)") }
            )
            // Persist user + assistant turns into the Mac session (keeps phone & Mac in sync).
            if var session = ChatSessionStore.load(id: sid) {
                session.history.append(LlmIdeAPIClient.CodeAssistTurn(role: .user, content: chat.text))
                session.history.append(LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: resp.reply))
                if session.title == "New chat" { session.title = String(chat.text.prefix(40)) }
                ChatSessionStore.save(session)
            }
            await server?.send(Output(commandId: chat.commandId,
                                      payload: OutputPayload(stream: resp.reply, done: true)))
        } catch {
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
}

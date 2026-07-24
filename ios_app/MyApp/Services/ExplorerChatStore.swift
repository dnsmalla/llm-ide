import Foundation
import SharedProtocol

/// State + send/handle logic for the explorer-chat surface (the "Explore"
/// sheet): persistent Mac-side sessions, the currently-loaded one, and its
/// live transcript. Owns its OWN `isStreaming` flag, independent of
/// `LlmIdeChatStore`. Holds a weak reference to the `ConnectionService` to send
/// outbound frames.
@MainActor
final class ExplorerChatStore: ObservableObject {
    /// Explorer-chat sessions (Mac-side persistent state) + the currently
    /// loaded one. `exploreCurrent.history` is the live transcript.
    @Published var exploreSessions: [ExploreSessionSummary] = []
    @Published var exploreCurrent: ExploreCurrentSession?
    /// True while a streamed reply for THIS surface is in flight. Replaces the
    /// pre-refactor shared `llmStreaming` flag.
    @Published var isStreaming: Bool = false

    /// Command ids whose streamed reply belongs to this transcript. Explore
    /// chat is one-in-flight, but a Set mirrors `LlmIdeChatStore` and is robust
    /// to overlapping done/stream frames.
    private var exploreCommandIds: Set<String> = []

    weak var connection: ConnectionService?

    init(connection: ConnectionService) {
        self.connection = connection
        // Register so the receive loop can route `explore_session_*` and
        // `output`/`error` frames here.
        connection.explorerStore = self
    }

    // MARK: — Session senders

    /// Ask the Mac for the current list of explorer-chat sessions. Reply lands
    /// in `exploreSessions` via the `explore_session_list` handler.
    func exploreListSessions() {
        connection?.sendEncodable(ExploreListSessions())
    }

    /// Load a session's full history into `exploreCurrent`. Reply arrives via
    /// `explore_session_history`.
    func exploreLoadSession(_ id: String) {
        connection?.sendEncodable(ExploreLoadSession(sessionId: id))
    }

    /// Create a new session on the Mac. Reply (`explore_session_created`)
    /// resets `exploreCurrent` to the new id with empty history and refreshes
    /// the session list.
    func exploreNewSession() {
        connection?.sendEncodable(ExploreNewSession())
    }

    /// Delete a session on the Mac and refresh the list.
    func exploreDeleteSession(_ id: String) {
        connection?.sendEncodable(ExploreDeleteSession(sessionId: id))
        // Optimistic local drop + reload, kept inline (the order — send, then
        // mutate, then re-list — is preserved exactly from pre-refactor).
        exploreSessions.removeAll { $0.id == id }
        if exploreCurrent?.id == id { exploreCurrent = nil }
        exploreListSessions()
    }

    /// Send a chat turn within the current explorer session. The reply streams
    /// back through the same `output`/`done` path as `LlmIdeChatStore`, routed
    /// by `commandId` membership in `exploreCommandIds`.
    func sendExploreChat(_ text: String, sessionId: String) {
        guard connection?.connectionStatus == .connected else { return }
        // If the caller is chatting without a loaded session (edge case),
        // initialize a local one bound to the provided sessionId.
        if exploreCurrent == nil {
            exploreCurrent = ExploreCurrentSession(id: sessionId, title: "Session", history: [])
        }
        // `exploreCurrent` is a value type — mutate a local copy through the
        // shared helper, then reassign so `@Published` fires deterministically.
        var messages = exploreCurrent?.history ?? []
        let (id, chatHistory) = mintStreamingTurn(
            messages: &messages,
            commandIds: &exploreCommandIds,
            userText: text
        )
        exploreCurrent?.history = messages
        isStreaming = true
        let chat = ExploreChat(sessionId: sessionId, commandId: id, text: text, history: chatHistory)
        // Encode error path preserved from pre-refactor (surface message, no tear-down).
        if let data = try? JSONEncoder().encode(chat),
           let str = String(data: data, encoding: .utf8) {
            connection?.sendTextFrame(str)
        } else {
            connection?.errorMessage = "Failed to encode explore chat message"
        }
    }

    // MARK: — Inbound (called by ConnectionService.receiveMessage dispatch)

    /// Handle `explore_session_*` frames that refresh sessions / load history.
    func handleInbound(type: String, data: Data) {
        switch type {
        case "explore_session_list":
            if let list = try? JSONDecoder().decode(ExploreSessionList.self, from: data) {
                exploreSessions = list.sessions
            }
        case "explore_session_history":
            if let hist = try? JSONDecoder().decode(ExploreSessionHistory.self, from: data) {
                exploreCurrent = ExploreCurrentSession(
                    id: hist.sessionId,
                    title: hist.title,
                    history: hist.history.map {
                        ChatMessage(role: $0.role == "assistant" ? .assistant : .user, text: $0.content)
                    }
                )
            }
        case "explore_session_created":
            if let created = try? JSONDecoder().decode(ExploreSessionCreated.self, from: data) {
                exploreCurrent = ExploreCurrentSession(id: created.sessionId, title: "New session", history: [])
                exploreListSessions()   // refresh the sidebar list
            }
        default:
            break
        }
    }

    /// Handle a streamed `output` frame. Only acts when this store owns the
    /// frame's commandId: appends a `stream` chunk to the last assistant
    /// placeholder, and on `done` clears this surface's `isStreaming` flag and
    /// drops the commandId.
    func handleOutput(commandId: String?, payload: [String: Any]) {
        let owns = commandId.map { exploreCommandIds.contains($0) } ?? false
        guard owns else { return }
        if let chunk = payload["stream"] as? String, !chunk.isEmpty {
            // `exploreCurrent` is a value type; mutate a local copy then
            // reassign so `@Published` fires deterministically.
            guard var current = exploreCurrent else { return }
            appendToLastAssistant(&current.history, chunk)
            exploreCurrent = current
        }
        if let done = payload["done"] as? Bool, done {
            isStreaming = false
            if let id = commandId { exploreCommandIds.remove(id) }
        }
    }

    /// Handle a top-level `error` frame: clear this surface's streaming flag
    /// and drop the empty placeholder left by a failed turn. Called for both
    /// chat stores from `ConnectionService.handleMessage`.
    func handleChatError() {
        isStreaming = false
        if var current = exploreCurrent {
            removeTrailingEmptyAssistant(&current.history)
            exploreCurrent = current
        }
    }
}

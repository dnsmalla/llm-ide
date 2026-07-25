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
    /// Mac workspace filename search (for @file / @folder picker).
    @Published var workspaceMatches: [ExploreWorkspaceEntry] = []
    @Published var workspaceSearchRoot: String?
    @Published var workspaceSearchError: String?
    @Published var isSearchingWorkspace: Bool = false
    /// Mac agent skill search (for /skill picker).
    @Published var skillMatches: [ExploreSkillEntry] = []
    @Published var skillSearchError: String?
    @Published var isSearchingSkills: Bool = false

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

    /// Send a chat turn within the current explorer session. Optional `files`
    /// carry text extracted on the iPhone; the Mac attaches them and runs the
    /// full code-assist agent with desktop Settings.
    func sendExploreChat(_ text: String, sessionId: String,
                         files: [ChatFileText] = [], refs: [ExploreWorkspaceRef] = [],
                         skills: [ExploreSkillRef] = []) {
        guard connection?.connectionStatus == .connected else { return }
        if exploreCurrent == nil {
            exploreCurrent = ExploreCurrentSession(id: sessionId, title: "Session", history: [])
        }
        let displayText = Self.transcriptText(text: text, refs: refs, files: files, skills: skills)
        var messages = exploreCurrent?.history ?? []
        let (id, chatHistory) = mintStreamingTurn(
            messages: &messages,
            commandIds: &exploreCommandIds,
            userText: displayText
        )
        exploreCurrent?.history = messages
        isStreaming = true
        let chat = ExploreChat(sessionId: sessionId, commandId: id, text: text,
                               history: chatHistory, files: files, refs: refs, skills: skills)
        if let data = try? JSONEncoder().encode(chat),
           let str = String(data: data, encoding: .utf8) {
            connection?.sendTextFrame(str)
        } else {
            connection?.errorMessage = "Failed to encode explore chat message"
        }
    }

    /// Search the Mac workspace for files/folders matching `query`.
    func searchWorkspace(_ query: String) {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard connection?.connectionStatus == .connected, q.count >= 2 else {
            workspaceMatches = []
            return
        }
        isSearchingWorkspace = true
        workspaceSearchError = nil
        connection?.sendEncodable(ExploreSearchFiles(query: q))
    }

    /// Search Mac agent skills matching `query`.
    func searchSkills(_ query: String) {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard connection?.connectionStatus == .connected, q.count >= 1 else {
            skillMatches = []
            return
        }
        isSearchingSkills = true
        skillSearchError = nil
        connection?.sendEncodable(ExploreSearchSkills(query: q))
    }

    private static func transcriptText(text: String, refs: [ExploreWorkspaceRef],
                                       files: [ChatFileText], skills: [ExploreSkillRef]) -> String {
        var parts: [String] = []
        if !skills.isEmpty {
            parts.append(skills.map(\.displayLabel).joined(separator: "\n"))
        }
        if !refs.isEmpty {
            parts.append(refs.map(\.displayLabel).joined(separator: "\n"))
        }
        if !files.isEmpty {
            parts.append(files.map { "📎 \($0.name)" }.joined(separator: "\n"))
        }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !body.isEmpty { parts.append(body) }
        if parts.isEmpty { return "Run with selected Mac context." }
        return parts.joined(separator: "\n\n")
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

    func handleSearchReply(_ reply: ExploreSearchReply) {
        isSearchingWorkspace = false
        workspaceMatches = reply.matches
        workspaceSearchRoot = reply.workspaceRoot
        workspaceSearchError = reply.error
    }

    func handleSkillSearchReply(_ reply: ExploreSkillListReply) {
        isSearchingSkills = false
        skillMatches = reply.matches
        skillSearchError = reply.error
    }

    func ownsCommand(_ id: String) -> Bool { exploreCommandIds.contains(id) }

    /// Handle a streamed `output` frame. Only acts when this store owns the
    /// frame's commandId: appends a `stream` chunk to the last assistant
    /// placeholder, and on `done` clears this surface's `isStreaming` flag and
    /// drops the commandId.
    func handleOutput(commandId: String?, payload: [String: Any]) {
        let owns = commandId.map { exploreCommandIds.contains($0) } ?? false
        guard owns else { return }
        let done = payload["done"] as? Bool ?? false
        if let chunk = payload["stream"] as? String, !chunk.isEmpty {
            guard var current = exploreCurrent else { return }
            setLastAssistant(&current.history, chunk)
            exploreCurrent = current
        }
        if done {
            isStreaming = false
            if let id = commandId { exploreCommandIds.remove(id) }
        }
    }

    func handleChatError(commandId: String? = nil) {
        isStreaming = false
        if let commandId { exploreCommandIds.remove(commandId) }
        if var current = exploreCurrent {
            removeTrailingEmptyAssistant(&current.history)
            exploreCurrent = current
        }
    }
}

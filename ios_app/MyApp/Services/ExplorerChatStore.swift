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
    /// True while waiting for Mac to return a session id / history (auto-provision).
    @Published var isPreparingSession: Bool = false
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
    /// The turn Stop should cancel — most recently minted commandId.
    private var currentCommandId: String?

    private struct PendingExploreSend {
        let text: String
        let files: [ChatFileText]
        let refs: [ExploreWorkspaceRef]
        let skills: [ExploreSkillRef]
    }
    private var pendingSend: PendingExploreSend?
    /// Session id whose history load is in flight (dedupes parallel load requests).
    private var loadingSessionId: String?
    private var sessionPrepGeneration: Int = 0
    private var sessionPrepTimeoutTask: Task<Void, Never>?
    private var streamTimeoutTask: Task<Void, Never>?

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
        guard connection?.sendEncodable(ExploreListSessions()) == true else {
            cancelSessionPrep(message: "Not connected to your Mac — wait for Live status, then try again.")
            return
        }
    }

    /// Load a session's full history into `exploreCurrent`. Reply arrives via
    /// `explore_session_history`.
    func exploreLoadSession(_ id: String) {
        guard connection?.sendEncodable(ExploreLoadSession(sessionId: id)) == true else {
            loadingSessionId = nil
            cancelSessionPrep(message: "Not connected to your Mac — wait for Live status, then try again.")
            return
        }
    }

    /// Create a new session on the Mac. Reply (`explore_session_created`)
    /// resets `exploreCurrent` to the new id with empty history and refreshes
    /// the session list.
    func exploreNewSession() {
        guard connection?.sendEncodable(ExploreNewSession()) == true else {
            cancelSessionPrep(message: "Not connected to your Mac — wait for Live status, then try again.")
            return
        }
        loadingSessionId = nil
        beginSessionPrep()
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
        guard connection?.connectionStatus == .connected else {
            connection?.errorMessage = "Not connected to your Mac — wait for Live status, then try again."
            return
        }
        if exploreCurrent == nil {
            exploreCurrent = ExploreCurrentSession(id: sessionId, title: "Session", history: [])
        }
        let displayText = Self.transcriptText(text: text, refs: refs, files: files, skills: skills)
        var messages = exploreCurrent?.history ?? []
        // The returned history turns are unused — the Mac's own session file
        // is the canonical transcript now; only the minted command id goes
        // on the wire.
        let (id, _) = mintStreamingTurn(
            messages: &messages,
            commandIds: &exploreCommandIds,
            userText: displayText
        )
        exploreCurrent?.history = messages
        isStreaming = true
        currentCommandId = id
        startStreamTimeout(for: id)
        let chat = ExploreChat(sessionId: sessionId, commandId: id, text: text,
                               files: files, refs: refs, skills: skills)
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
                ensureActiveSession(from: list.sessions)
            } else {
                cancelSessionPrep(message: "Couldn't read the session list from your Mac — try again.")
            }
        case "explore_session_history":
            if let hist = try? JSONDecoder().decode(ExploreSessionHistory.self, from: data) {
                loadingSessionId = nil
                exploreCurrent = ExploreCurrentSession(
                    id: hist.sessionId,
                    title: hist.title,
                    history: hist.history.map {
                        ChatMessage(role: $0.role == "assistant" ? .assistant : .user, text: $0.content)
                    }
                )
                completeSessionPrep()
                flushPendingSend()
            } else {
                loadingSessionId = nil
                cancelSessionPrep(message: "Couldn't load that session from your Mac — creating a new one.")
                exploreNewSession()
            }
        case "explore_session_created":
            if let created = try? JSONDecoder().decode(ExploreSessionCreated.self, from: data) {
                loadingSessionId = nil
                exploreCurrent = ExploreCurrentSession(id: created.sessionId, title: "New session", history: [])
                completeSessionPrep()
                flushPendingSend()
                exploreListSessions()   // refresh the sidebar list
            } else {
                cancelSessionPrep(message: "Couldn't start a new session on your Mac — try again.")
            }
        case "explore_session_renamed":
            if let renamed = try? JSONDecoder().decode(ExploreSessionRenamed.self, from: data) {
                if let idx = exploreSessions.firstIndex(where: { $0.id == renamed.sessionId }) {
                    let old = exploreSessions[idx]
                    exploreSessions[idx] = ExploreSessionSummary(
                        id: old.id, title: renamed.title, lastUsedAt: old.lastUsedAt)
                }
                if exploreCurrent?.id == renamed.sessionId {
                    exploreCurrent?.title = renamed.title
                }
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
            streamTimeoutTask?.cancel()
            isStreaming = false
            if let id = commandId {
                exploreCommandIds.remove(id)
                if currentCommandId == id { currentCommandId = nil }
            }
        }
    }

    func handleChatError(commandId: String? = nil) {
        streamTimeoutTask?.cancel()
        isStreaming = false
        if let commandId {
            exploreCommandIds.remove(commandId)
            if currentCommandId == commandId { currentCommandId = nil }
        } else {
            // Connection-wide failure: every in-flight turn is dead. Orphans
            // left here would make a later Stop cancel a corpse and let a
            // replayed frame append into a live transcript.
            exploreCommandIds.removeAll()
            currentCommandId = nil
        }
        if var current = exploreCurrent {
            removeTrailingEmptyAssistant(&current.history)
            exploreCurrent = current
        }
    }

    /// Blank slate for a newly paired Mac: the previous machine's session id is
    /// meaningless there, and `exploreCurrent != nil` would make
    /// `prepareSessionIfNeeded` short-circuit so the first send goes out
    /// against a session that doesn't exist.
    func resetForNewDevice() {
        streamTimeoutTask?.cancel()
        streamTimeoutTask = nil
        sessionPrepTimeoutTask?.cancel()
        sessionPrepTimeoutTask = nil
        sessionPrepGeneration &+= 1
        isPreparingSession = false
        isStreaming = false
        exploreCommandIds.removeAll()
        currentCommandId = nil
        pendingSend = nil
        loadingSessionId = nil
        exploreCurrent = nil
        exploreSessions = []
    }

    /// Cancel the in-flight explore chat turn on the Mac.
    func cancelStreaming() {
        // Not `Set.first` — that's nondeterministic with two ids in flight.
        guard let commandId = currentCommandId else { return }
        connection?.sendEncodable(ExploreCancel(commandId: commandId))
    }

    /// Rename an explorer session on the Mac.
    func exploreRenameSession(_ sessionId: String, title: String) {
        connection?.sendEncodable(ExploreRenameSession(sessionId: sessionId, title: title), userFacing: true)
    }

    /// Mac explore session ops failed (load/list/new) — recover or surface the error.
    func handleSessionCommandError(_ message: String, commandId: String?) {
        guard let commandId, commandId.hasPrefix("explore_") else { return }
        loadingSessionId = nil
        if commandId == "explore_load" {
            // Stale or missing session on disk — start fresh instead of spinning forever.
            connection?.errorMessage = message
            if exploreCurrent == nil {
                exploreNewSession()
            } else {
                completeSessionPrep()
            }
            return
        }
        cancelSessionPrep(message: message)
    }

    /// Refresh sessions when the sheet opens or the connection becomes Live.
    func refreshIfConnected() {
        guard connection?.connectionStatus == .connected else { return }
        guard !isPreparingSession else { return }
        exploreListSessions()
    }

    /// Auto-select or create a Mac session so the send button works without
    /// opening "Browse sessions" first.
    func prepareSessionIfNeeded() {
        guard connection?.connectionStatus == .connected else { return }
        guard exploreCurrent == nil, !isPreparingSession, !isStreaming else { return }
        beginSessionPrep()
        exploreListSessions()
    }

    /// Queue a send until `exploreCurrent` is ready (auto-provision path).
    func queueSendWhenReady(text: String, files: [ChatFileText] = [],
                            refs: [ExploreWorkspaceRef] = [],
                            skills: [ExploreSkillRef] = []) {
        pendingSend = PendingExploreSend(text: text, files: files, refs: refs, skills: skills)
        prepareSessionIfNeeded()
        if exploreCurrent != nil { flushPendingSend() }
    }

    private func flushPendingSend() {
        guard let pending = pendingSend, let id = exploreCurrent?.id else { return }
        pendingSend = nil
        sendExploreChat(pending.text, sessionId: id, files: pending.files,
                        refs: pending.refs, skills: pending.skills)
    }

    /// Pick the most recent Mac session (or create one) so the send button works
    /// without an extra "Browse sessions" step.
    private func ensureActiveSession(from sessions: [ExploreSessionSummary]) {
        guard exploreCurrent == nil, !isStreaming else { return }
        guard loadingSessionId == nil else { return }
        if let latest = sessions.max(by: { $0.lastUsedAt < $1.lastUsedAt }) {
            beginSessionPrep()
            loadingSessionId = latest.id
            exploreLoadSession(latest.id)
        } else if connection?.connectionStatus == .connected {
            exploreNewSession()
        } else {
            cancelSessionPrep(message: "Not connected to your Mac — wait for Live status, then try again.")
        }
    }

    private func beginSessionPrep() {
        isPreparingSession = true
        sessionPrepGeneration &+= 1
        let generation = sessionPrepGeneration
        sessionPrepTimeoutTask?.cancel()
        sessionPrepTimeoutTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard !Task.isCancelled, generation == sessionPrepGeneration else { return }
            guard isPreparingSession, exploreCurrent == nil else { return }
            loadingSessionId = nil
            cancelSessionPrep(message: "Timed out waiting for your Mac — tap Browse sessions or try again.")
        }
    }

    private func completeSessionPrep() {
        sessionPrepGeneration &+= 1
        sessionPrepTimeoutTask?.cancel()
        sessionPrepTimeoutTask = nil
        isPreparingSession = false
    }

    private func cancelSessionPrep(message: String) {
        completeSessionPrep()
        loadingSessionId = nil
        // Drop the queued turn: `flushPendingSend` fires on the NEXT successful
        // session load, which can be minutes later and a different session.
        pendingSend = nil
        connection?.errorMessage = message
    }

    private func startStreamTimeout(for commandId: String) {
        streamTimeoutTask?.cancel()
        streamTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 120_000_000_000)
            guard !Task.isCancelled, let self else { return }
            guard self.exploreCommandIds.contains(commandId) else { return }
            self.connection?.errorMessage =
                "Timed out waiting for your Mac — check LLM-IDE backend and Mobile Control log."
            self.handleChatError(commandId: commandId)
            self.connection?.sendEncodable(ExploreCancel(commandId: commandId))
        }
    }
}

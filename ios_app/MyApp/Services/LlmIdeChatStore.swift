import Foundation
import SharedProtocol

/// Transcript + send/handle logic for the llm-ide chat surface (the "Chat"
/// sheet). Owns its OWN `isStreaming` flag — distinct from
/// `ExplorerChatStore.isStreaming` — so a streaming reply on one surface no
/// longer disables the send button on the other (the shared-`llmStreaming`
/// smell flagged in the audit). Holds a weak reference to the
/// `ConnectionService` to send outbound frames.
@MainActor
final class LlmIdeChatStore: ObservableObject {
    /// Transcript for the llm-ide chat sheet.
    @Published var llmIdeMessages: [ChatMessage] = []
    /// True while a streamed reply for THIS surface is in flight. Replaces the
    /// pre-refactor shared `llmStreaming` flag.
    @Published var isStreaming: Bool = false

    /// Command ids whose streamed reply belongs to this transcript.
    private var llmIdeCommandIds: Set<String> = []
    /// The turn Stop should cancel — the most recently minted commandId. The id
    /// SET stays (a late frame for an older turn must still be routable), but
    /// cancellation needs a deterministic target.
    private var currentCommandId: String?
    private var streamTimeoutTask: Task<Void, Never>?
    /// Commands that have shown the Mac's approval pause note — once seen,
    /// every later idle-timeout restart for that command keeps the LONG
    /// window until `done`. Sticky on purpose: an answered approval is
    /// typically followed by an expensive tool run that can be legitimately
    /// silent for more than the normal window, and timing out sends Cancel,
    /// killing the very turn the user just approved on the Mac.
    private var approvalPausedCommandIds: Set<String> = []

    weak var connection: ConnectionService?

    init(connection: ConnectionService) {
        self.connection = connection
        // Register so the receive loop can route `output`/`error` frames here.
        connection.llmIdeStore = self
    }

    // MARK: — Send

    /// Ask llm-ide's agent a question. The agent on the Mac forwards it to the
    /// llm-ide localhost API and the reply streams back through the same
    /// `output`/`done` path, landing in `llmIdeMessages`.
    ///
    /// `images` are pre-resized JPEG data (displayed as thumbnails on the other
    /// side); `files` carry text already extracted on-device (PDF/`.md`/`.txt`),
    /// never binary, so the WS frame stays well under the 8 MiB bridge cap.
    func sendLlmideChat(_ text: String,
                        images: [(data: Data, mediaType: String)] = [],
                        files: [ChatFileText] = []) {
        guard connection?.connectionStatus == .connected else {
            connection?.errorMessage = "Not connected to your Mac — wait for Live status, then try again."
            return
        }
        // Show only the first attached image as a thumbnail in the local bubble.
        let (id, history) = mintStreamingTurn(
            messages: &llmIdeMessages,
            commandIds: &llmIdeCommandIds,
            userText: text,
            imageData: images.first?.data
        )
        isStreaming = true
        currentCommandId = id
        startStreamTimeout(for: id)
        let chatImages = images.map { ChatImage(mediaType: $0.mediaType, data: $0.data.base64EncodedString()) }
        let chat = LlmIdeChat(commandId: id, text: text, history: history, images: chatImages, files: files)
        // Encode error path preserved exactly from pre-refactor (tear down).
        do {
            let data = try JSONEncoder().encode(chat)
            if let str = String(data: data, encoding: .utf8) {
                connection?.sendTextFrame(str)
            } else {
                connection?.errorMessage = "Failed to encode chat message: UTF-8 conversion failed"
                handleChatError(commandId: id)
                connection?.disconnect()
            }
        } catch {
            connection?.errorMessage = "Failed to encode chat message: \(error.localizedDescription)"
            handleChatError(commandId: id)
            connection?.disconnect()
        }
    }

    /// Load the shared server transcript (same history as Mac llm-chat sheet).
    func loadSharedHistory() {
        connection?.sendEncodable(LlmIdeChatHistoryList(limit: 50))
    }

    func clearLlmIdeChat() {
        llmIdeMessages.removeAll()
        connection?.sendEncodable(LlmIdeChatHistoryClear(), userFacing: true)
    }

    /// Cancel the in-flight llm-ide chat turn on the Mac.
    func cancelStreaming() {
        // `Set.first` is nondeterministic — with two ids in flight Stop could
        // cancel the wrong turn. Track the live one explicitly.
        guard let commandId = currentCommandId else { return }
        connection?.sendEncodable(LlmIdeCancel(commandId: commandId))
    }

    // MARK: — Inbound (called by ConnectionService.receiveMessage dispatch)

    func handleInbound(type: String, data: Data) {
        switch type {
        case "llmide_chat_history_reply":
            if let reply = try? JSONDecoder().decode(LlmIdeChatHistoryReply.self, from: data),
               !isStreaming {
                let restored = reply.messages.enumerated().map { index, message in
                    ChatMessage(historyIndex: index,
                                role: message.role == "assistant" ? .assistant : .user,
                                text: message.content)
                }
                // Carry local-only `imageData` across the swap: the server
                // transcript has no images, so a just-sent thumbnail used to
                // vanish from its bubble the moment the reply completed.
                llmIdeMessages = Self.preservingAttachments(from: llmIdeMessages, into: restored)
            }
        case "llmide_chat_history_clear_ack":
            if (try? JSONDecoder().decode(LlmIdeChatHistoryClearAck.self, from: data))?.ok == true {
                llmIdeMessages.removeAll()
            }
        default:
            break
        }
    }

    func ownsCommand(_ id: String) -> Bool { llmIdeCommandIds.contains(id) }

    /// Re-attach image thumbnails the server transcript can't carry, matching
    /// on (role, text) from the most recent local turns.
    static func preservingAttachments(from local: [ChatMessage],
                                      into restored: [ChatMessage]) -> [ChatMessage] {
        guard local.contains(where: { $0.imageData != nil }) else { return restored }
        // Walk BOTH lists forward. Matching on (role, text) alone attached the
        // image to the FIRST identical turn — send "look" without an image,
        // then "look" with one, and the thumbnail landed on the older bubble.
        var cursor = local.startIndex
        return restored.map { message in
            while cursor < local.endIndex {
                let candidate = local[cursor]
                cursor += 1
                guard candidate.role == message.role, candidate.text == message.text else { continue }
                guard let imageData = candidate.imageData else { return message }
                var merged = message
                merged.imageData = imageData
                return merged
            }
            return message
        }
    }

    /// Handle a streamed `output` frame. Only acts when this store owns the
    /// frame's commandId: appends a `stream` chunk to the last assistant
    /// placeholder, and on `done` clears this surface's `isStreaming` flag and
    /// drops the commandId.
    func handleOutput(commandId: String?, payload: [String: Any]) {
        let owns = commandId.map { llmIdeCommandIds.contains($0) } ?? false
        guard owns else { return }
        let done = payload["done"] as? Bool ?? false
        if let chunk = payload["stream"] as? String, !chunk.isEmpty {
            if done {
                setLastAssistant(&llmIdeMessages, chunk)
            } else {
                appendToLastAssistant(&llmIdeMessages, chunk)
                // Every frame proves the Mac is alive and working, so restart
                // the timeout — it is an IDLE breaker, not a wall clock. The
                // old fire-once-from-send version cancelled healthy long
                // turns (and sent Cancel, killing them on the Mac) at 120 s
                // even while progress was streaming.
                if let id = commandId {
                    if chunk.contains(Self.approvalPauseGlyph) {
                        approvalPausedCommandIds.insert(id)
                    }
                    startStreamTimeout(for: id, idleSeconds: idleWindow(for: id))
                }
            }
        }
        if done {
            streamTimeoutTask?.cancel()
            isStreaming = false
            if let id = commandId {
                llmIdeCommandIds.remove(id)
                approvalPausedCommandIds.remove(id)
                if currentCommandId == id { currentCommandId = nil }
            }
            loadSharedHistory()
        }
    }

    func handleChatError(commandId: String? = nil) {
        streamTimeoutTask?.cancel()
        isStreaming = false
        if let commandId {
            llmIdeCommandIds.remove(commandId)
            approvalPausedCommandIds.remove(commandId)
            if currentCommandId == commandId { currentCommandId = nil }
        } else {
            // No id = the whole connection went down (ConnectionService
            // .disconnect). Every in-flight turn is dead, so drop them all:
            // leaving orphans behind means a later Stop cancels a command that
            // no longer exists, a late/replayed frame for that id appends into
            // the live transcript, and the set grows per dropped connection.
            llmIdeCommandIds.removeAll()
            approvalPausedCommandIds.removeAll()
            currentCommandId = nil
        }
        removeTrailingEmptyAssistant(&llmIdeMessages)
    }

    /// Blank slate for a newly paired Mac. Without this the previous machine's
    /// transcript stays on screen (and its in-flight ids stay routable).
    func resetForNewDevice() {
        streamTimeoutTask?.cancel()
        streamTimeoutTask = nil
        isStreaming = false
        llmIdeCommandIds.removeAll()
        approvalPausedCommandIds.removeAll()
        currentCommandId = nil
        llmIdeMessages.removeAll()
    }

    /// Glyph the Mac's approval pause note carries ("⏸ Question pending on
    /// Mac…", `ChatEngine.externalApprovalNote`) — forwarded through the
    /// same stream frames as ordinary progress. After it, the turn
    /// legitimately goes silent while a human answers the card on the Mac
    /// (up to the server's 15-minute decision TTL), so the idle breaker
    /// must outlast that. If the Mac ever changes the glyph, the phone
    /// merely degrades to the normal window — never worse than before.
    static let approvalPauseGlyph = "⏸"

    /// Long window once `commandId` has parked on an approval (sticky until
    /// done — see `approvalPausedCommandIds`), normal window otherwise.
    func idleWindow(for commandId: String) -> UInt64 {
        approvalPausedCommandIds.contains(commandId) ? 960 : 120
    }

    private func startStreamTimeout(for commandId: String, idleSeconds: UInt64 = 120) {
        streamTimeoutTask?.cancel()
        streamTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: idleSeconds * 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            guard self.llmIdeCommandIds.contains(commandId) else { return }
            self.connection?.errorMessage =
                "Timed out waiting for your Mac — check LLM-IDE backend and Mobile Control log."
            self.handleChatError(commandId: commandId)
            self.connection?.sendEncodable(LlmIdeCancel(commandId: commandId))
        }
    }
}

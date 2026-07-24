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
        guard connection?.connectionStatus == .connected else { return }
        // Show only the first attached image as a thumbnail in the local bubble.
        let (id, history) = mintStreamingTurn(
            messages: &llmIdeMessages,
            commandIds: &llmIdeCommandIds,
            userText: text,
            imageData: images.first?.data
        )
        isStreaming = true
        let chatImages = images.map { ChatImage(mediaType: $0.mediaType, data: $0.data.base64EncodedString()) }
        let chat = LlmIdeChat(commandId: id, text: text, history: history, images: chatImages, files: files)
        // Encode error path preserved exactly from pre-refactor (tear down).
        if let data = try? JSONEncoder().encode(chat),
           let str = String(data: data, encoding: .utf8) {
            connection?.sendTextFrame(str)
        } else {
            connection?.errorMessage = "Failed to encode chat message"
            connection?.disconnect()
        }
    }

    func clearLlmIdeChat() {
        llmIdeMessages.removeAll()
    }

    // MARK: — Inbound (called by ConnectionService.receiveMessage dispatch)

    /// Handle a streamed `output` frame. Only acts when this store owns the
    /// frame's commandId: appends a `stream` chunk to the last assistant
    /// placeholder, and on `done` clears this surface's `isStreaming` flag and
    /// drops the commandId.
    func handleOutput(commandId: String?, payload: [String: Any]) {
        let owns = commandId.map { llmIdeCommandIds.contains($0) } ?? false
        guard owns else { return }
        if let chunk = payload["stream"] as? String, !chunk.isEmpty {
            appendToLastAssistant(&llmIdeMessages, chunk)
        }
        if let done = payload["done"] as? Bool, done {
            isStreaming = false
            if let id = commandId { llmIdeCommandIds.remove(id) }
        }
    }

    /// Handle a top-level `error` frame: clear this surface's streaming flag
    /// and drop the empty "…" placeholder left by a failed turn. Called for
    /// both chat stores from `ConnectionService.handleMessage`, mirroring the
    /// pre-refactor blanket reset (resetting an already-idle surface is a
    /// harmless no-op).
    func handleChatError() {
        isStreaming = false
        removeTrailingEmptyAssistant(&llmIdeMessages)
    }
}

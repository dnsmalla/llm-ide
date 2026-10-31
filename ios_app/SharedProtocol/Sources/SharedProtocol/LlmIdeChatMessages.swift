import Foundation

// MARK: - llm-ide chat channel (Phase 3)

public struct ChatTurn: Codable, Equatable {
    public let role: String
    public let content: String
    public init(role: String, content: String) { self.role = role; self.content = content }
}

public struct ChatImage: Codable, Equatable {
    public let mediaType: String
    public let data: String
    public init(mediaType: String, data: String) { self.mediaType = mediaType; self.data = data }
}

public struct ChatFileText: Codable, Equatable {
    public let name: String
    public let text: String
    public init(name: String, text: String) { self.name = name; self.text = text }
}

/// Client → server: ask the llm-ide agent a question. Files carry text extracted on-device (not binary) to
/// stay under the WS frame cap.
///
/// `history` and `images` are **deprecated and ignored**: the Mac's session store is the transcript (it never
/// read `history`), and the Mac refuses images in this chat. They stay decodable so an older phone that still
/// sends them is understood. A current phone sends them empty (an older Mac still requires the keys). Decoding
/// tolerates their absence.
public struct LlmIdeChat: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmIdeChat
    public let commandId: String
    public let text: String
    /// Deprecated, ignored by the Mac.
    public let history: [ChatTurn]
    /// Deprecated, refused by the Mac when non-empty.
    public let images: [ChatImage]
    public let files: [ChatFileText]
    public init(commandId: String, text: String, history: [ChatTurn] = [],
                images: [ChatImage] = [], files: [ChatFileText] = []) {
        self.commandId = commandId; self.text = text; self.history = history
        self.images = images; self.files = files
    }
    private enum CodingKeys: String, CodingKey { case type, commandId, text, history, images, files }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commandId = try c.decode(String.self, forKey: .commandId)
        text = try c.decode(String.self, forKey: .text)
        history = try c.decodeIfPresent([ChatTurn].self, forKey: .history) ?? []
        images = try c.decodeIfPresent([ChatImage].self, forKey: .images) ?? []
        files = try c.decodeIfPresent([ChatFileText].self, forKey: .files) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(commandId, forKey: .commandId)
        try c.encode(text, forKey: .text)
        // Always written (usually empty): a not-yet-updated Mac decodes them as required keys.
        try c.encode(history, forKey: .history)
        try c.encode(images, forKey: .images)
        try c.encode(files, forKey: .files)
    }
}

public struct OutputPayload: Codable, Equatable {
    public let stream: String?
    public let done: Bool
    public init(stream: String?, done: Bool) { self.stream = stream; self.done = done }
}

/// Server → client: the agent's reply. Nested `payload` matches the iOS receive loop.
public struct Output: Codable, Equatable {
    public let type = MobileProtocol.Tag.output
    public let commandId: String
    public let payload: OutputPayload
    public init(commandId: String, payload: OutputPayload) {
        self.commandId = commandId; self.payload = payload
    }
    private enum CodingKeys: String, CodingKey { case type, commandId, payload }
}

/// Server → client: a command failed.
public struct CommandError: Codable, Equatable {
    public let type = MobileProtocol.Tag.error
    public let commandId: String?
    public let message: String
    /// Machine-readable refusal reason (`task_disabled`, `desktop_only`, `tier_refused`, ...; see
    /// `MobileRefusalCode`). Additive and optional: an older phone ignores it and still shows `message`,
    /// an older Mac never sends it.
    public let code: String?
    public init(commandId: String?, message: String, code: String? = nil) {
        self.commandId = commandId; self.message = message; self.code = code
    }
    private enum CodingKeys: String, CodingKey { case type, commandId, message, code }
}

// MARK: - llm-chat history sync (Mac sheet + iPhone Chat tab)

public struct LlmIdeChatHistoryList: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmIdeChatHistoryList
    public let limit: Int?
    public init(limit: Int? = 50) { self.limit = limit }
    private enum CodingKeys: String, CodingKey { case type, limit }
}

public struct LlmIdeChatHistoryReply: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmIdeChatHistoryReply
    public let messages: [ChatTurn]
    public init(messages: [ChatTurn]) { self.messages = messages }
    private enum CodingKeys: String, CodingKey { case type, messages }
}

public struct LlmIdeChatHistoryClear: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmIdeChatHistoryClear
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

public struct LlmIdeChatHistoryClearAck: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmIdeChatHistoryClearAck
    public let ok: Bool
    public init(ok: Bool) { self.ok = ok }
    private enum CodingKeys: String, CodingKey { case type, ok }
}

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

/// Client → server: ask the llm-ide agent a question. Images are base64; files
/// carry text extracted on-device (not binary) to stay under the WS frame cap.
public struct LlmIdeChat: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmIdeChat
    public let commandId: String
    public let text: String
    public let history: [ChatTurn]
    public let images: [ChatImage]
    public let files: [ChatFileText]
    public init(commandId: String, text: String, history: [ChatTurn],
                images: [ChatImage] = [], files: [ChatFileText] = []) {
        self.commandId = commandId; self.text = text; self.history = history
        self.images = images; self.files = files
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
}

/// Server → client: a command failed.
public struct CommandError: Codable, Equatable {
    public let type = MobileProtocol.Tag.error
    public let commandId: String?
    public let message: String
    public init(commandId: String?, message: String) { self.commandId = commandId; self.message = message }
}

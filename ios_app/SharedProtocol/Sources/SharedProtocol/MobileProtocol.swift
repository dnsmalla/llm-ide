import Foundation

/// Wire-protocol constants shared by the macOS server and the iOS client.
public enum MobileProtocol {
    /// Bonjour service type advertised by the Mac app (no trailing dot).
    /// `NSBonjourServices` uses this form; `NetServiceBrowser` appends a dot.
    public static let serviceType = "_llmide._tcp"

    /// Default TCP port the Mac app listens on.
    public static let defaultPort = 3006

    /// Heartbeat cadence (seconds).
    public static let heartbeatInterval: TimeInterval = 10

    /// Drop the connection if no heartbeat is received within this window.
    public static let heartbeatTimeout: TimeInterval = 25
}

// MARK: - Connection lifecycle messages

/// Client → server keepalive.
public struct Heartbeat: Codable, Equatable {
    public let type = "heartbeat"
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case type
    }
}

/// Server → client heartbeat acknowledgement.
public struct HeartbeatAck: Codable, Equatable {
    public let type = "heartbeat_ack"
    public let ts: Double
    public init(ts: Double) { self.ts = ts }

    private enum CodingKeys: String, CodingKey {
        case type
        case ts
    }
}

/// Server → client: pairing succeeded; carry the Mac's device name.
public struct Connected: Codable, Equatable {
    public let type = "connected"
    public let deviceName: String
    public init(deviceName: String) { self.deviceName = deviceName }

    private enum CodingKeys: String, CodingKey {
        case type
        case deviceName
    }
}

/// Server → client: PIN rejected; sent before closing the socket.
public struct AuthFailed: Codable, Equatable {
    public let type = "auth_failed"
    public let message: String
    public init(message: String) { self.message = message }

    private enum CodingKeys: String, CodingKey {
        case type
        case message
    }
}

/// Client → server: first message after connecting; carries the pairing PIN.
public struct Pairing: Codable, Equatable {
    public let type = "pairing"
    public let pin: String
    public init(pin: String) { self.pin = pin }

    private enum CodingKeys: String, CodingKey {
        case type
        case pin
    }
}

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

/// Client → server: ask the llm-ide agent a question.
public struct LlmIdeChat: Codable, Equatable {
    public let type = "llmide_chat"
    public let commandId: String
    public let text: String
    public let history: [ChatTurn]
    public let image: ChatImage?
    public init(commandId: String, text: String, history: [ChatTurn], image: ChatImage?) {
        self.commandId = commandId; self.text = text; self.history = history; self.image = image
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case commandId
        case text
        case history
        case image
    }
}

public struct OutputPayload: Codable, Equatable {
    public let stream: String?
    public let done: Bool
    public init(stream: String?, done: Bool) { self.stream = stream; self.done = done }
}

/// Server → client: the agent's reply. Nested `payload` matches the iOS receive loop.
public struct Output: Codable, Equatable {
    public let type = "output"
    public let commandId: String
    public let payload: OutputPayload
    public init(commandId: String, payload: OutputPayload) {
        self.commandId = commandId; self.payload = payload
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case commandId
        case payload
    }
}

/// Server → client: a command failed.
public struct CommandError: Codable, Equatable {
    public let type = "error"
    public let commandId: String?
    public let message: String
    public init(commandId: String?, message: String) { self.commandId = commandId; self.message = message }

    private enum CodingKeys: String, CodingKey {
        case type
        case commandId
        case message
    }
}

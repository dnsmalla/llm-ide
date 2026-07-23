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

public struct ChatFileText: Codable, Equatable {
    public let name: String
    public let text: String
    public init(name: String, text: String) { self.name = name; self.text = text }
}

/// Client → server: ask the llm-ide agent a question. Images are base64; files
/// carry text extracted on-device (not binary) to stay under the WS frame cap.
public struct LlmIdeChat: Codable, Equatable {
    public let type = "llmide_chat"
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

    private enum CodingKeys: String, CodingKey {
        case type
        case commandId
        case text
        case history
        case images
        case files
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

// MARK: - Explorer-chat session messages (Phase B, Task 1)

public struct ExploreSessionSummary: Codable, Equatable {
    public let id: String
    public let title: String
    public let lastUsedAt: Double
    public init(id: String, title: String, lastUsedAt: Double) { self.id = id; self.title = title; self.lastUsedAt = lastUsedAt }

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case lastUsedAt
    }
}

public struct ExploreListSessions: Codable, Equatable {
    public let type = "explore_list_sessions"
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case type
    }
}

public struct ExploreSessionList: Codable, Equatable {
    public let type = "explore_session_list"
    public let sessions: [ExploreSessionSummary]
    public init(sessions: [ExploreSessionSummary]) { self.sessions = sessions }

    private enum CodingKeys: String, CodingKey {
        case type
        case sessions
    }
}

public struct ExploreLoadSession: Codable, Equatable {
    public let type = "explore_load_session"
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }

    private enum CodingKeys: String, CodingKey {
        case type
        case sessionId
    }
}

public struct ExploreSessionHistory: Codable, Equatable {
    public let type = "explore_session_history"
    public let sessionId: String
    public let title: String
    public let history: [ChatTurn]
    public init(sessionId: String, title: String, history: [ChatTurn]) { self.sessionId = sessionId; self.title = title; self.history = history }

    private enum CodingKeys: String, CodingKey {
        case type
        case sessionId
        case title
        case history
    }
}

public struct ExploreNewSession: Codable, Equatable {
    public let type = "explore_new_session"
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case type
    }
}

public struct ExploreSessionCreated: Codable, Equatable {
    public let type = "explore_session_created"
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }

    private enum CodingKeys: String, CodingKey {
        case type
        case sessionId
    }
}

public struct ExploreDeleteSession: Codable, Equatable {
    public let type = "explore_delete_session"
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }

    private enum CodingKeys: String, CodingKey {
        case type
        case sessionId
    }
}

public struct ExploreChat: Codable, Equatable {
    public let type = "explore_chat"
    public let sessionId: String
    public let commandId: String
    public let text: String
    public let history: [ChatTurn]
    public init(sessionId: String, commandId: String, text: String, history: [ChatTurn]) {
        self.sessionId = sessionId; self.commandId = commandId; self.text = text; self.history = history
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case sessionId
        case commandId
        case text
        case history
    }
}

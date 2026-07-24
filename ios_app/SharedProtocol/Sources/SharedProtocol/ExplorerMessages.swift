import Foundation

// MARK: - Explorer-chat session messages (Phase B, Task 1)

public struct ExploreSessionSummary: Codable, Equatable {
    public let id: String
    public let title: String
    public let lastUsedAt: Double
    public init(id: String, title: String, lastUsedAt: Double) { self.id = id; self.title = title; self.lastUsedAt = lastUsedAt }
}

public struct ExploreListSessions: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreListSessions
    public init() {}
}

public struct ExploreSessionList: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSessionList
    public let sessions: [ExploreSessionSummary]
    public init(sessions: [ExploreSessionSummary]) { self.sessions = sessions }
}

public struct ExploreLoadSession: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreLoadSession
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
}

public struct ExploreSessionHistory: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSessionHistory
    public let sessionId: String
    public let title: String
    public let history: [ChatTurn]
    public init(sessionId: String, title: String, history: [ChatTurn]) { self.sessionId = sessionId; self.title = title; self.history = history }
}

public struct ExploreNewSession: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreNewSession
    public init() {}
}

public struct ExploreSessionCreated: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSessionCreated
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
}

public struct ExploreDeleteSession: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreDeleteSession
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
}

public struct ExploreChat: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreChat
    public let sessionId: String
    public let commandId: String
    public let text: String
    public let history: [ChatTurn]
    public init(sessionId: String, commandId: String, text: String, history: [ChatTurn]) {
        self.sessionId = sessionId; self.commandId = commandId; self.text = text; self.history = history
    }
}

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
    private enum CodingKeys: String, CodingKey { case type }
}

public struct ExploreSessionList: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSessionList
    public let sessions: [ExploreSessionSummary]
    public init(sessions: [ExploreSessionSummary]) { self.sessions = sessions }
    private enum CodingKeys: String, CodingKey { case type, sessions }
}

public struct ExploreLoadSession: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreLoadSession
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
    private enum CodingKeys: String, CodingKey { case type, sessionId }
}

public struct ExploreSessionHistory: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSessionHistory
    public let sessionId: String
    public let title: String
    public let history: [ChatTurn]
    public init(sessionId: String, title: String, history: [ChatTurn]) { self.sessionId = sessionId; self.title = title; self.history = history }
    private enum CodingKeys: String, CodingKey { case type, sessionId, title, history }
}

public struct ExploreNewSession: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreNewSession
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

public struct ExploreSessionCreated: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSessionCreated
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
    private enum CodingKeys: String, CodingKey { case type, sessionId }
}

public struct ExploreDeleteSession: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreDeleteSession
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
    private enum CodingKeys: String, CodingKey { case type, sessionId }
}

public struct ExploreChat: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreChat
    public let sessionId: String
    public let commandId: String
    public let text: String
    public let history: [ChatTurn]
    /// Text extracted on the iPhone (PDF / plain text). The Mac converts these
    /// to code-assist attachments and runs the prompt with Mac agent settings.
    public let files: [ChatFileText]
    /// Mac workspace paths selected on the iPhone (`@file` / `@folder`).
    public let refs: [ExploreWorkspaceRef]
    /// Mac agent skills selected on the iPhone (`/skill name`).
    public let skills: [ExploreSkillRef]
    public init(sessionId: String, commandId: String, text: String, history: [ChatTurn],
                files: [ChatFileText] = [], refs: [ExploreWorkspaceRef] = [],
                skills: [ExploreSkillRef] = []) {
        self.sessionId = sessionId
        self.commandId = commandId
        self.text = text
        self.history = history
        self.files = files
        self.refs = refs
        self.skills = skills
    }
    private enum CodingKeys: String, CodingKey {
        case type, sessionId, commandId, text, history, files, refs, skills
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        commandId = try c.decode(String.self, forKey: .commandId)
        text = try c.decode(String.self, forKey: .text)
        history = try c.decode([ChatTurn].self, forKey: .history)
        files = try c.decodeIfPresent([ChatFileText].self, forKey: .files) ?? []
        refs = try c.decodeIfPresent([ExploreWorkspaceRef].self, forKey: .refs) ?? []
        skills = try c.decodeIfPresent([ExploreSkillRef].self, forKey: .skills) ?? []
    }
}

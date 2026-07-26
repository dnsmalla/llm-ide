import Foundation

// MARK: - Mac status snapshot (Phase A)

public struct MacStatusList: Codable, Equatable {
    public let type = MobileProtocol.Tag.macStatusList
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

public struct MacStatus: Codable, Equatable {
    public let type = MobileProtocol.Tag.macStatus
    public let projectName: String?
    public let gitBranch: String?
    public let workspacePath: String?
    public let backendUp: Bool
    public let mobileControlUp: Bool

    public init(projectName: String?, gitBranch: String?, workspacePath: String?,
                backendUp: Bool, mobileControlUp: Bool) {
        self.projectName = projectName
        self.gitBranch = gitBranch
        self.workspacePath = workspacePath
        self.backendUp = backendUp
        self.mobileControlUp = mobileControlUp
    }
    private enum CodingKeys: String, CodingKey {
        case type, projectName, gitBranch, workspacePath, backendUp, mobileControlUp
    }
}

public struct LlmIdeCancel: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmIdeCancel
    public let commandId: String
    public init(commandId: String) { self.commandId = commandId }
    private enum CodingKeys: String, CodingKey { case type, commandId }
}

public struct ExploreCancel: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreCancel
    public let commandId: String
    public init(commandId: String) { self.commandId = commandId }
    private enum CodingKeys: String, CodingKey { case type, commandId }
}

public struct ExploreRenameSession: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreRenameSession
    public let sessionId: String
    public let title: String
    public init(sessionId: String, title: String) {
        self.sessionId = sessionId
        self.title = title
    }
    private enum CodingKeys: String, CodingKey { case type, sessionId, title }
}

public struct ExploreSessionRenamed: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSessionRenamed
    public let sessionId: String
    public let title: String
    public init(sessionId: String, title: String) {
        self.sessionId = sessionId
        self.title = title
    }
    private enum CodingKeys: String, CodingKey { case type, sessionId, title }
}

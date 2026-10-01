import Foundation

// MARK: - Projects
//
// The phone can see the Mac's recent projects and ask it to open one. Ids and display names only:
// paths never cross the wire, and the Mac resolves a requested id against ITS OWN recents list —
// the phone cannot name a folder.

public struct ProjectInfo: Codable, Equatable, Identifiable, Hashable {
    public let id: String
    public let name: String
    /// Seconds since 1970; nil for the active project entry when unknown.
    public let lastOpenedAt: Double?
    public init(id: String, name: String, lastOpenedAt: Double? = nil) {
        self.id = id
        self.name = name
        self.lastOpenedAt = lastOpenedAt
    }
}

public struct ProjectList: Codable, Equatable {
    public let type = MobileProtocol.Tag.projectList
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

public struct ProjectSwitch: Codable, Equatable {
    public let type = MobileProtocol.Tag.projectSwitch
    public let id: String
    public init(id: String) { self.id = id }
    private enum CodingKeys: String, CodingKey { case type, id }
}

/// Reply to `project_list` and `project_switch`. After a refused or failed switch `error` says why
/// and `active` is still the project that is open.
public struct ProjectState: Codable, Equatable {
    public let type = MobileProtocol.Tag.projectState
    public let active: ProjectInfo?
    /// Most recent first.
    public let projects: [ProjectInfo]
    public let error: String?
    public init(active: ProjectInfo?, projects: [ProjectInfo], error: String? = nil) {
        self.active = active
        self.projects = projects
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, active, projects, error }
}

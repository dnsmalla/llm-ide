import Foundation

// MARK: - Mac skill search (/skill for iPhone Explore)

public struct ExploreSkillEntry: Codable, Equatable, Identifiable {
    /// Stable id — library: `"skills/foo"`, builtin: `"skill:name"`, subagent: `"sub:plugin:name"`.
    public let id: String
    public let name: String
    public let description: String
    /// `"library"` | `"builtin"` | `"subagent"`
    public let kind: String
    /// For builtin/subagent skills — prepended to the outgoing message on Mac.
    public let directive: String?

    public init(id: String, name: String, description: String, kind: String, directive: String?) {
        self.id = id
        self.name = name
        self.description = description
        self.kind = kind
        self.directive = directive
    }
}

/// Client → server: find Mac agent skills by name.
public struct ExploreSearchSkills: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSearchSkills
    public let query: String
    public let limit: Int?
    public init(query: String, limit: Int? = 40) {
        self.query = query
        self.limit = limit
    }
    private enum CodingKeys: String, CodingKey { case type, query, limit }
}

/// Server → client: skill matches from the Mac backend catalog.
public struct ExploreSkillListReply: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSkillListReply
    public let matches: [ExploreSkillEntry]
    public let error: String?

    public init(matches: [ExploreSkillEntry], error: String?) {
        self.matches = matches
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, matches, error }
}

/// A Mac skill invoked from the iPhone Explore composer.
public struct ExploreSkillRef: Codable, Equatable, Identifiable {
    public let id: String
    public let name: String
    /// `"library"` (sent via skills channel) or `"directive"` (prepended text).
    public let kind: String
    public let directive: String?

    public init(id: String, name: String, kind: String, directive: String?) {
        self.id = id
        self.name = name
        self.kind = kind
        self.directive = directive
    }

    public var displayLabel: String { "/\(name)" }
}

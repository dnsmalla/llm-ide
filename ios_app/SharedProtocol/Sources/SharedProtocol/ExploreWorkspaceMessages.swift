import Foundation

// MARK: - Mac workspace search (@file / @folder for iPhone Explore)

public struct ExploreWorkspaceEntry: Codable, Equatable, Identifiable {
    /// Path relative to the Mac workspace root (e.g. `extension/server.mjs`).
    public let path: String
    public let name: String
    public let isDirectory: Bool
    public var id: String { path }

    public init(path: String, name: String, isDirectory: Bool) {
        self.path = path
        self.name = name
        self.isDirectory = isDirectory
    }
}

/// Client → server: find files/folders by name under the Mac workspace.
public struct ExploreSearchFiles: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSearchFiles
    public let query: String
    public let limit: Int?
    public init(query: String, limit: Int? = 40) {
        self.query = query
        self.limit = limit
    }
    private enum CodingKeys: String, CodingKey { case type, query, limit }
}

/// Server → client: filename matches (newest/shallow paths first).
public struct ExploreSearchReply: Codable, Equatable {
    public let type = MobileProtocol.Tag.exploreSearchReply
    public let workspaceRoot: String?
    public let matches: [ExploreWorkspaceEntry]
    public let error: String?

    public init(workspaceRoot: String?, matches: [ExploreWorkspaceEntry], error: String?) {
        self.workspaceRoot = workspaceRoot
        self.matches = matches
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, workspaceRoot, matches, error }
}

/// A Mac workspace path referenced from the iPhone (`@file` / `@folder`).
public struct ExploreWorkspaceRef: Codable, Equatable, Identifiable {
    public let path: String
    /// `"file"` or `"folder"`
    public let kind: String
    public var id: String { "\(kind):\(path)" }

    public init(path: String, kind: String) {
        self.path = path
        self.kind = kind
    }

    public var displayLabel: String {
        kind == "folder" ? "@folder \(path)" : "@file \(path)"
    }
}

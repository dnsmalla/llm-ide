import Foundation

// MARK: - Project files (read-only)
//
// A read-only viewer for the active project's code. The Mac resolves every path against the
// project root (no `..`, no absolute paths, no symlinks out), hides dotfiles and well-known
// secret files, skips build/dependency folders, reads text only up to a cap, and scrubs known
// token shapes from what it sends. There is no write path.

public struct FileEntry: Codable, Equatable, Identifiable, Hashable {
    public let name: String
    public let isDirectory: Bool
    public let size: Int
    public var id: String { name }
    public init(name: String, isDirectory: Bool, size: Int) {
        self.name = name
        self.isDirectory = isDirectory
        self.size = size
    }
}

public struct FilesList: Codable, Equatable {
    public let type = MobileProtocol.Tag.filesList
    /// Project-relative directory; "" is the project root.
    public let path: String
    public init(path: String) { self.path = path }
    private enum CodingKeys: String, CodingKey { case type, path }
}

public struct FilesListing: Codable, Equatable {
    public let type = MobileProtocol.Tag.filesListing
    public let path: String
    public let entries: [FileEntry]
    public let truncated: Bool
    public let error: String?
    public init(path: String, entries: [FileEntry], truncated: Bool = false, error: String? = nil) {
        self.path = path
        self.entries = entries
        self.truncated = truncated
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, path, entries, truncated, error }
}

public struct FilesRead: Codable, Equatable {
    public let type = MobileProtocol.Tag.filesRead
    public let path: String
    public init(path: String) { self.path = path }
    private enum CodingKeys: String, CodingKey { case type, path }
}

public struct FilesFile: Codable, Equatable {
    public let type = MobileProtocol.Tag.filesFile
    public let path: String
    public let text: String?
    public let truncated: Bool
    public let error: String?
    public init(path: String, text: String?, truncated: Bool = false, error: String? = nil) {
        self.path = path
        self.text = text
        self.truncated = truncated
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, path, text, truncated, error }
}

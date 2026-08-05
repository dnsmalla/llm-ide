import Foundation

/// Surfaced name/fs failures from Explorer file operations. Inline-able in the
/// name sheet; mapped to a user-facing string via `errorDescription`.
enum ExplorerFileError: LocalizedError, Equatable {
    case emptyName
    case invalidName
    case alreadyExists
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .emptyName: return "Name can't be empty."
        case .invalidName: return "Name can't contain \"/\" or be \".\" or \"..\"."
        case .alreadyExists: return "An item with this name already exists."
        case .writeFailed: return "Couldn't create the item."
        }
    }
}

/// Stateless mutating file operations for the Explorer tree. All paths are
/// validated and existence-checked here so the view can stay declarative and
/// the logic is testable without UI. Delete uses `trashItem` (Finder Trash,
/// undoable) — never `removeItem`.
enum ExplorerFileOps {
    /// Throws if `name` is empty/whitespace, or contains "/" or is "." / "..".
    private static func validate(_ name: String) throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ExplorerFileError.emptyName }
        guard trimmed != ".", trimmed != "..", !trimmed.contains("/") else {
            throw ExplorerFileError.invalidName
        }
        return trimmed
    }

    @discardableResult
    static func createFile(in dir: URL, name: String) throws -> URL {
        let trimmed = try validate(name)
        let url = dir.appendingPathComponent(trimmed)
        guard !FileManager.default.fileExists(atPath: url.path) else { throw ExplorerFileError.alreadyExists }
        guard FileManager.default.createFile(atPath: url.path, contents: Data(), attributes: nil) else {
            throw ExplorerFileError.writeFailed
        }
        return url
    }

    @discardableResult
    static func createFolder(in dir: URL, name: String) throws -> URL {
        let trimmed = try validate(name)
        let url = dir.appendingPathComponent(trimmed)
        guard !FileManager.default.fileExists(atPath: url.path) else { throw ExplorerFileError.alreadyExists }
        do { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false) }
        catch { throw ExplorerFileError.writeFailed }
        return url
    }

    /// Rename `url` to `newName` (same parent). Returns the new URL. No-op
    /// (returns the original) when the name is unchanged.
    @discardableResult
    static func rename(_ url: URL, to newName: String) throws -> URL {
        let trimmed = try validate(newName)
        let dest = url.deletingLastPathComponent().appendingPathComponent(trimmed)
        if dest == url { return url }
        guard !FileManager.default.fileExists(atPath: dest.path) else { throw ExplorerFileError.alreadyExists }
        try FileManager.default.moveItem(at: url, to: dest)
        return dest
    }

    /// Move `url` (file or folder, recursively) to the Trash.
    static func trash(_ url: URL) throws {
        var result: NSURL?
        try FileManager.default.trashItem(at: url, resultingItemURL: &result)
    }
}

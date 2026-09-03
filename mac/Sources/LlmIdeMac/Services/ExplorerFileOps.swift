import Foundation

/// Surfaced name/fs failures from Explorer file operations. Inline-able in the
/// name sheet; mapped to a user-facing string via `errorDescription`.
enum ExplorerFileError: LocalizedError, Equatable {
    case emptyName
    case invalidName
    case alreadyExists
    case writeFailed
    /// Dropping/pasting a folder into itself or into one of its own
    /// descendants. `FileManager.moveItem` would either fail with an opaque
    /// Cocoa error or (for a copy) recurse forever, so this is caught first.
    case cannotMoveIntoSelf

    var errorDescription: String? {
        switch self {
        case .emptyName: return "Name can't be empty."
        case .invalidName: return "Name can't contain \"/\" or be \".\" or \"..\"."
        case .alreadyExists: return "An item with this name already exists."
        case .writeFailed: return "Couldn't create the item."
        case .cannotMoveIntoSelf: return "Can't move a folder into itself."
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

    /// Guard shared by `move` and `copy`: rejects "into itself" and "into my
    /// own descendant" before any filesystem call. `isDescendant` is strict,
    /// so the equality case is checked separately.
    private static func assertNotSelfNesting(source: URL, destinationDir: URL) throws {
        if ExplorerPaths.key(source) == ExplorerPaths.key(destinationDir) {
            throw ExplorerFileError.cannotMoveIntoSelf
        }
        if ExplorerPaths.isDescendant(destinationDir, of: source) {
            throw ExplorerFileError.cannotMoveIntoSelf
        }
    }

    /// Move `source` INTO the directory `destinationDir`, keeping its name.
    /// Returns the new URL.
    ///
    /// Never overwrites: a name collision throws `.alreadyExists` rather than
    /// silently destroying the destination file (unlike copy, which
    /// auto-uniquifies — a drag that clobbers a file is a data-loss bug, a
    /// drag that produces "x copy.txt" is Finder behavior).
    ///
    /// Moving into the directory the item already lives in is a no-op that
    /// returns the original URL — a drag that lands where it started must not
    /// throw at the user.
    @discardableResult
    static func move(from source: URL, to destinationDir: URL) throws -> URL {
        try assertNotSelfNesting(source: source, destinationDir: destinationDir)
        let dest = destinationDir.appendingPathComponent(source.lastPathComponent)
        if ExplorerPaths.key(dest) == ExplorerPaths.key(source) { return source }
        guard !FileManager.default.fileExists(atPath: dest.path) else {
            throw ExplorerFileError.alreadyExists
        }
        try FileManager.default.moveItem(at: source, to: dest)
        return dest
    }

    /// Copy `source` INTO the directory `destinationDir`, auto-uniquifying the
    /// name Finder-style on collision. Returns the new URL.
    @discardableResult
    static func copy(from source: URL, to destinationDir: URL) throws -> URL {
        try assertNotSelfNesting(source: source, destinationDir: destinationDir)
        let dest = uniqueDestination(in: destinationDir, name: source.lastPathComponent)
        try FileManager.default.copyItem(at: source, to: dest)
        return dest
    }

    /// A free URL for `name` inside `dir`, following Finder's naming:
    /// `a.txt` → `a copy.txt` → `a copy 2.txt` → `a copy 3.txt`. The base name
    /// and extension are split with `deletingPathExtension`/`pathExtension`
    /// so a dotted directory name (`my.notes`) keeps its suffix intact.
    ///
    /// The loop is bounded: after 1000 attempts it falls back to a UUID
    /// suffix rather than spinning forever on a pathological directory.
    static func uniqueDestination(in dir: URL, name: String) -> URL {
        let fm = FileManager.default
        let first = dir.appendingPathComponent(name)
        guard fm.fileExists(atPath: first.path) else { return first }

        let asURL = URL(fileURLWithPath: name)
        let ext = asURL.pathExtension
        let base = asURL.deletingPathExtension().lastPathComponent

        func candidate(_ suffix: String) -> URL {
            let stem = base + suffix
            return ext.isEmpty
                ? dir.appendingPathComponent(stem)
                : dir.appendingPathComponent(stem + "." + ext)
        }

        let plainCopy = candidate(" copy")
        if !fm.fileExists(atPath: plainCopy.path) { return plainCopy }
        for n in 2...1000 {
            let url = candidate(" copy \(n)")
            if !fm.fileExists(atPath: url.path) { return url }
        }
        return candidate(" copy \(UUID().uuidString)")
    }
}

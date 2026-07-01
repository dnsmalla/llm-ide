// Strict validators for the Settings → Paths card.
//
// Every path-typed AppConfig field that the user can edit runs its
// raw value through one of these before persistence. The Settings
// row shows ✓/⚠ + a one-line reason; the row's Save button is
// disabled while the result is `.invalid`.

import Foundation

enum PathValidation: Equatable {
    case ok(canonical: String)
    case warning(message: String, canonical: String)
    case invalid(reason: String)

    var isValid: Bool {
        if case .invalid = self { return false }
        return true
    }

    var canonical: String? {
        switch self {
        case .ok(let c), .warning(_, let c): return c
        case .invalid: return nil
        }
    }
}

enum PathValidator {

    // MARK: - Memory subdir (relative, can't escape repo)

    /// Accept a *relative* path that doesn't contain `..`, doesn't
    /// start with `/`, doesn't start with `~`, and has at least one
    /// non-empty segment. Returns the cleaned relative path on the
    /// success arm so the caller persists a canonical form (no
    /// trailing slashes, no `./` prefix).
    static func memorySubdir(_ raw: String) -> PathValidation {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            return .invalid(reason: "Memory subdir cannot be empty.")
        }
        if trimmed.hasPrefix("/") {
            return .invalid(reason: "Use a path relative to the repo root, not an absolute path.")
        }
        if trimmed.hasPrefix("~") {
            return .invalid(reason: "Home-relative paths (~) aren't allowed — use a path inside the repo.")
        }
        let segments = trimmed.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if segments.isEmpty {
            return .invalid(reason: "Memory subdir cannot be empty.")
        }
        if segments.contains("..") {
            return .invalid(reason: "Path segments cannot contain `..` — that could escape the repo.")
        }
        if segments.contains(where: { $0.contains("\0") }) {
            return .invalid(reason: "Path contains an invalid character.")
        }
        let canonical = segments.joined(separator: "/")
        return .ok(canonical: canonical)
    }

    // MARK: - Executable file (Understand-Anything binary, etc.)

    /// Accept an empty string (= "auto-discover") OR an absolute path
    /// pointing at an existing executable file. Returns the canonical
    /// path (symlinks resolved) on success.
    static func executableFile(_ raw: String, allowEmpty: Bool = true) -> PathValidation {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            return allowEmpty
                ? .ok(canonical: "")
                : .invalid(reason: "Path cannot be empty.")
        }
        let expanded = (trimmed as NSString).expandingTildeInPath
        if !expanded.hasPrefix("/") {
            return .invalid(reason: "Must be an absolute path (start with / or ~).")
        }
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: expanded, isDirectory: &isDir) else {
            return .invalid(reason: "No file at \(expanded).")
        }
        if isDir.boolValue {
            return .invalid(reason: "Path points to a directory, not an executable file.")
        }
        if !fm.isExecutableFile(atPath: expanded) {
            return .invalid(reason: "File exists but isn't executable.")
        }
        // Resolve symlinks so the persisted value is stable across
        // /opt/homebrew → /usr/local symlinks etc.
        let canonical = (URL(fileURLWithPath: expanded).resolvingSymlinksInPath()).path
        return .ok(canonical: canonical)
    }

    // MARK: - Absolute directory (allow missing — for workspace root)

    /// Like `existingDirectory` but accepts a path that doesn't
    /// exist yet (the user will create it via "Create missing
    /// folders"). The path itself must still be absolute and not
    /// point to an existing *file*. Returns the canonical expanded
    /// path on success.
    static func absoluteDirectoryAllowMissing(_ raw: String) -> PathValidation {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            return .invalid(reason: "Pick a workspace root — every subfolder below resolves under it.")
        }
        let expanded = (trimmed as NSString).expandingTildeInPath
        if !expanded.hasPrefix("/") {
            return .invalid(reason: "Must be an absolute path (start with / or ~).")
        }
        let fm = FileManager.default
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: expanded, isDirectory: &isDir) {
            if !isDir.boolValue {
                return .invalid(reason: "A file already exists here — pick a directory path.")
            }
            let canonical = (URL(fileURLWithPath: expanded).resolvingSymlinksInPath()).path
            if !fm.isWritableFile(atPath: canonical) {
                return .warning(message: "Directory exists but isn't writable — create-folder actions will fail.", canonical: canonical)
            }
            return .ok(canonical: canonical)
        }
        // Doesn't exist yet — that's fine, but check the parent is
        // a real directory we could create under.
        let parent = (expanded as NSString).deletingLastPathComponent
        if !parent.isEmpty, !fm.fileExists(atPath: parent) {
            return .invalid(reason: "Parent directory \(parent) doesn't exist.")
        }
        return .warning(message: "Doesn't exist yet — use \"Create missing folders\" to create it.", canonical: expanded)
    }

    // MARK: - Subfolder name (no `..`, no `/`-prefix, may be multi-segment)

    /// Same shape as `memorySubdir` but without the "different from
    /// default" warning — used for the user-renamed workspace
    /// subfolders (Notes, Docs, Clones, InfiniteBrain).
    static func subfolderName(_ raw: String) -> PathValidation {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            return .invalid(reason: "Subfolder name cannot be empty.")
        }
        if trimmed.hasPrefix("/") {
            return .invalid(reason: "Use a relative name, not an absolute path.")
        }
        if trimmed.hasPrefix("~") {
            return .invalid(reason: "Home-relative paths (~) aren't allowed here.")
        }
        let segments = trimmed.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if segments.isEmpty {
            return .invalid(reason: "Subfolder name cannot be empty.")
        }
        if segments.contains("..") {
            return .invalid(reason: "Segments cannot contain `..`.")
        }
        if segments.contains(where: { $0.contains("\0") || $0.contains(":") }) {
            return .invalid(reason: "Contains an invalid character.")
        }
        return .ok(canonical: segments.joined(separator: "/"))
    }

}

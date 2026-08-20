import Foundation

/// Pure path-routing rules for the single-source project layout.
/// No I/O — these decide *where* a file belongs; the store does the move.
enum ProjectPaths {
    /// Image extensions always live under data/, regardless of the
    /// section the user added from.
    static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "bmp", "tiff", "svg"
    ]

    /// The canonical subfolder a file belongs in. Images fold into data/.
    static func subfolder(for category: LibraryItem.Category, fileName: String) -> String {
        let ext = (fileName as NSString).pathExtension.lowercased()
        if imageExtensions.contains(ext) { return "data" }
        switch category {
        case .code:     return "code"
        case .data:     return "data"
        case .notes:    return "llm-doc"
        case .meetings: return "source"
        }
    }

    /// Absolute destination for a file copied into the project.
    static func destinationURL(root: URL, category: LibraryItem.Category, fileName: String) -> URL {
        root.appendingPathComponent(subfolder(for: category, fileName: fileName), isDirectory: true)
            .appendingPathComponent(fileName)
    }

    /// True when `url` lives inside `root` (directory-boundary aware).
    /// Compared on canonical paths (symlinks resolved, case-insensitive):
    /// the same folder can be spelled with a different case or reached via
    /// a symlink — macOS volumes are case-insensitive by default — and a
    /// literal prefix compare then misclassifies an in-project folder as
    /// external (double-indexing every file) or copies an in-project file
    /// onto itself. Must stay in step with the store's canonical
    /// `projectRoot` (LibraryItemStore.bindProject) — one rule, two sides.
    static func isInside(_ url: URL, root: URL) -> Bool {
        let r = canonicalPath(root)
        let p = canonicalPath(url)
        if p.compare(r, options: .caseInsensitive) == .orderedSame { return true }
        let prefix = r.hasSuffix("/") ? r : r + "/"
        guard p.count > prefix.count else { return false }
        return String(p.prefix(prefix.count)).compare(prefix, options: .caseInsensitive) == .orderedSame
    }

    /// On-disk canonical path (case + symlinks) when the entry exists;
    /// the standardized spelling otherwise — nonexistent paths still
    /// compare consistently against themselves.
    private static func canonicalPath(_ url: URL) -> String {
        let standardized = url.standardizedFileURL
        if let canonical = (try? standardized.resourceValues(forKeys: [.canonicalPathKey]))?.canonicalPath {
            return canonical
        }
        return standardized.resolvingSymlinksInPath().path
    }
}

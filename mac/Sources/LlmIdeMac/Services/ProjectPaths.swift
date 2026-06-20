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
        case .notes:    return "notes"
        case .meetings: return "source"
        }
    }

    /// Absolute destination for a file copied into the project.
    static func destinationURL(root: URL, category: LibraryItem.Category, fileName: String) -> URL {
        root.appendingPathComponent(subfolder(for: category, fileName: fileName), isDirectory: true)
            .appendingPathComponent(fileName)
    }

    /// True when `url` lives inside `root` (directory-boundary aware).
    static func isInside(_ url: URL, root: URL) -> Bool {
        let r = root.standardizedFileURL.path
        let p = url.standardizedFileURL.path
        return p == r || p.hasPrefix(r.hasSuffix("/") ? r : r + "/")
    }
}

import Foundation

/// Lazy, per-level filesystem walk for the Explorer tree. Enumerates ONE
/// directory level at a time (not recursive) so large trees stay cheap.
enum FileSystemTree {
    struct Node: Identifiable, Hashable {
        let url: URL
        let name: String
        let isDirectory: Bool
        var id: String { url.path }
    }

    /// Directories to never show (build/cache/VCS). See `IgnoreList`.
    static let noiseNames: Set<String> = IgnoreList.directories

    /// Children of `dir`, directories first then files, case-insensitive by
    /// name, skipping hidden dotfiles and noise dirs. Empty on unreadable dir.
    static func children(of dir: URL) -> [Node] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]) else { return [] }
        let nodes: [Node] = entries.compactMap { url in
            let name = url.lastPathComponent
            if noiseNames.contains(name) { return nil }
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            return Node(url: url, name: name, isDirectory: isDir)
        }
        return nodes.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory && !b.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }
}

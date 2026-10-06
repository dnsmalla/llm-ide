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

    /// Hidden entries the OS creates itself: never useful in a project tree.
    /// Every OTHER dotfile (`.gitignore`, `.env`, `.github/`, `.claude/`) is shown —
    /// they are ordinary project files that people edit, and hiding them all
    /// left `.github/workflows/ci.yml` unreachable from the in-app tree.
    static let systemNoiseFiles: Set<String> = [
        ".DS_Store", ".localized", ".Trash", ".Spotlight-V100", ".fseventsd",
        ".TemporaryItems", ".DocumentRevisions-V100", ".VolumeIcon.icns", ".AppleDouble",
    ]

    /// Children of `dir`, directories first then files, case-insensitive by
    /// name, skipping OS noise files and noise dirs (other dotfiles are shown). Empty on unreadable dir.
    static func children(of dir: URL) -> [Node] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: []) else { return [] }
        let nodes: [Node] = entries.compactMap { url in
            let name = url.lastPathComponent
            if noiseNames.contains(name) || systemNoiseFiles.contains(name) { return nil }
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            return Node(url: url, name: name, isDirectory: isDir)
        }
        return nodes.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory && !b.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }
}

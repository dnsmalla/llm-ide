import Foundation

/// Maps a project root to the repo directory the code graph is generated
/// from. Lives in core (not Graph/) because the auto-task pipeline needs the
/// mapping even in builds where the Graph feature is excluded.
enum RepoGraphLocator {
    /// Moved verbatim from `GraphAutoUpdater.repoToGraph` — same behavior.
    static func repoToGraph(projectRoot: URL) -> URL? {
        let fm = FileManager.default
        func hasGraph(_ root: URL) -> Bool {
            fm.fileExists(atPath: ProjectLayout(root: root).graphDir.appendingPathComponent("index.md").path)
        }
        let codeDir = ProjectLayout(root: projectRoot).codeDir
        let children = (try? fm.contentsOfDirectory(at: codeDir, includingPropertiesForKeys: [.isDirectoryKey],
                                                    options: [.skipsHiddenFiles])) ?? []
        let dirs = children.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        if !dirs.isEmpty {
            // Clone-into-code layout: graph a `code/<child>` git repo (clean,
            // fast, .gitignore-respecting). Prefer one already graphed for
            // incremental stability, else the first child. NEVER graph the
            // project workspace root here even if it carries a stale graph —
            // it isn't a git repo and holds the tool's own `system/` output, so
            // scanning it ingests ~20k generated files (slow + meaningless).
            return dirs.first(where: hasGraph) ?? dirs.first
        }
        // No code/ children: graph the project root iff it actually holds files.
        let hasFiles = ((try? fm.contentsOfDirectory(at: projectRoot, includingPropertiesForKeys: nil,
                                                     options: [.skipsHiddenFiles]))?.isEmpty == false)
        return hasFiles ? projectRoot : nil
    }
}

import Foundation

/// The folders an Auto Task's input/output can point at: the project's Library
/// roots (`source/`, `code/`, `data/`, `llm-doc/`) and the directories inside
/// them, as project-relative paths.
///
/// Scans DIRECTORIES rather than deriving folders from the Library's file
/// index, because a task's output path is usually a folder that has no files in
/// it yet — an index-derived list would omit exactly the folder the user is
/// trying to select. The same scan feeds the Mac picker and the iPhone's, so
/// the two surfaces cannot drift.
///
/// Pure and nonisolated: no store, no actor, testable against a temp directory.
enum AutoTaskFolderCatalog {

    /// How deep below a Library root to descend. Four covers the deepest
    /// canonical layout (`llm-doc/<type>/<YYYY>/<MM>/`) with one to spare;
    /// unbounded recursion on a large `code/` tree would produce a list nobody
    /// can scroll.
    static let maxDepth = 4

    /// Upper bound on returned paths, so a repo with thousands of directories
    /// cannot make the picker unusable (or the mobile payload enormous).
    static let maxResults = 400

    struct Folder: Identifiable, Equatable, Hashable {
        /// Project-relative, e.g. `llm-doc/emails/2026`.
        let path: String
        /// Which Library section it belongs to.
        let category: LibraryItem.Category
        /// Nesting below the project root; a Library root itself is 1.
        let depth: Int
        var id: String { path }
    }

    /// Every selectable folder under `projectRoot`, sorted by path. Returns
    /// empty when the root is nil or unreadable — the caller shows its own
    /// "open a project" state rather than a misleading empty success.
    static func scan(projectRoot: URL?) -> [Folder] {
        guard let projectRoot else { return [] }
        let fm = FileManager.default
        var results: [Folder] = []

        for root in ProjectLayout.userFolders {
            let rootURL = projectRoot.appendingPathComponent(root.name, isDirectory: true)
            var isDirectory: ObjCBool = false
            guard fm.fileExists(atPath: rootURL.path, isDirectory: &isDirectory),
                  isDirectory.boolValue else { continue }
            results.append(Folder(path: root.name, category: root.category, depth: 1))
            appendChildren(of: rootURL, relativePath: root.name, category: root.category,
                           depth: 2, into: &results, fm: fm)
            if results.count >= maxResults { break }
        }

        return Array(results.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
            .prefix(maxResults))
    }

    private static func appendChildren(of url: URL, relativePath: String,
                                       category: LibraryItem.Category, depth: Int,
                                       into results: inout [Folder], fm: FileManager) {
        guard depth <= maxDepth, results.count < maxResults else { return }
        guard let entries = try? fm.contentsOfDirectory(
            at: url, includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants]) else { return }

        for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            guard results.count < maxResults else { return }
            guard (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
            let path = "\(relativePath)/\(entry.lastPathComponent)"
            results.append(Folder(path: path, category: category, depth: depth))
            appendChildren(of: entry, relativePath: path, category: category,
                           depth: depth + 1, into: &results, fm: fm)
        }
    }
}

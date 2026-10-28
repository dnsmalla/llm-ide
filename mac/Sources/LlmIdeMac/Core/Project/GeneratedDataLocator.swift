import Foundation

/// The ONE resolver for where a project's GENERATED knowledge lives: code
/// graph, agent memory, faults, saved Q&A (user decision D1, 2026-10-28).
///
/// Rule: generated data always lives in the PROJECT's own `<projectRoot>/system/`,
/// never in a cloned repo's `system/` under `code/<child>/`. The cloned repo is
/// only an INPUT (the code being graphed). Every writer and reader that needs
/// one of these locations calls this type; none computes `<repo>/system` itself.
///
/// Layout under the project root:
/// ```
/// system/memory/                 agent memory (graph-notes.md, doc-notes.md, chat-memory.md)
/// system/faults/  system/q&a/    fault reports, saved Q&A (MemoryStore container: system/)
/// system/repo.md                 curated project facts (MemoryStore container)
/// system/graph/                  code graph of the project's only repo (flat)
/// system/graph/<repo-slug>/      code graph per repo, when the project has 2+ code/<child> repos
/// ```
///
/// Flat vs per-repo graph rule: `graph/` is flat when the project graphs at most
/// one repo (the project root itself, or a single `code/<child>`). With two or
/// more `code/<child>` repos each gets `graph/<child-folder-name>/`. The rule is
/// derived from the directory listing on every call, so adding or removing a
/// second repo moves the graph location; the next auto-update regenerates it and
/// `GeneratedDataMigration` relocates legacy data at project open.
///
/// Project-root detection: a path whose parent is named `code` AND whose
/// grandparent holds `system/project.json` is a `code/<child>` repo. Anything else
/// (including a project that happens to live under `~/code/`) is its own root.
enum GeneratedDataLocator {

    // MARK: - Project root

    /// The project a repo path belongs to. `<project>/code/<child>` → `<project>`;
    /// any other path is a project root in its own right.
    static func projectRoot(forRepo repo: URL) -> URL {
        let std = repo.standardizedFileURL
        let parent = std.deletingLastPathComponent()
        guard parent.lastPathComponent == "code" else { return std }
        let grand = parent.deletingLastPathComponent()
        let marker = ProjectLayout(root: grand).projectJSON
        return FileManager.default.fileExists(atPath: marker.path) ? grand : std
    }

    // MARK: - Writer locations (always project-level)

    /// `<project>/system/`.
    static func systemDir(forRepo repo: URL) -> URL {
        ProjectLayout(root: projectRoot(forRepo: repo)).systemDir
    }

    /// `<project>/system/memory/` — agent memory artifacts, one per project.
    static func memoryDir(forRepo repo: URL) -> URL {
        ProjectLayout(root: projectRoot(forRepo: repo)).memoryDir
    }

    /// `<project>/system/faults/`.
    static func faultsDir(forRepo repo: URL) -> URL {
        ProjectLayout(root: projectRoot(forRepo: repo)).faultsDir
    }

    /// `<project>/system/q&a/`.
    static func qaDir(forRepo repo: URL) -> URL {
        systemDir(forRepo: repo).appendingPathComponent("q&a", isDirectory: true)
    }

    /// Code graph output directory for `repo`: flat `system/graph/` when the project
    /// graphs at most one repo, else `system/graph/<repo-folder-name>/`.
    /// Does NOT call `RepoGraphLocator`, so `RepoGraphLocator` may call it safely.
    static func graphDir(forRepo repo: URL) -> URL {
        let project = projectRoot(forRepo: repo)
        let base = ProjectLayout(root: project).graphDir
        let std = repo.standardizedFileURL
        guard std.path != project.standardizedFileURL.path else { return base }
        guard codeChildRepos(projectRoot: project).count > 1 else { return base }
        return base.appendingPathComponent(std.lastPathComponent, isDirectory: true)
    }

    // MARK: - Reader locations (new location first, legacy N-1 fallback)

    /// Graph directory to READ from: the current location when its `index.md`
    /// exists, else the legacy `<repo>/system/graph/` when that holds one, else
    /// the current location (so a missing graph still reads as "not generated").
    static func readableGraphDir(forRepo repo: URL) -> URL {
        let current = graphDir(forRepo: repo)
        if FileManager.default.fileExists(atPath: current.appendingPathComponent("index.md").path) {
            return current
        }
        let legacy = legacySystemDir(forRepo: repo).appendingPathComponent("graph", isDirectory: true)
        if FileManager.default.fileExists(atPath: legacy.appendingPathComponent("index.md").path) {
            return legacy
        }
        return current
    }

    /// Memory directory to READ from: the project location when it exists, else the
    /// legacy `<repo>/system/memory/` (N-1), else the project location.
    static func readableMemoryDir(forRepo repo: URL) -> URL {
        let current = memoryDir(forRepo: repo)
        if FileManager.default.fileExists(atPath: current.path) { return current }
        let legacy = legacySystemDir(forRepo: repo).appendingPathComponent("memory", isDirectory: true)
        return FileManager.default.fileExists(atPath: legacy.path) ? legacy : current
    }

    /// The pre-D1 location a cloned repo used to hold: `<repo>/system/`. Read-only
    /// fallback; nothing writes here any more. Sole legitimate producer of this path.
    static func legacySystemDir(forRepo repo: URL) -> URL {
        repo.standardizedFileURL.appendingPathComponent("system", isDirectory: true)
    }

    // MARK: - Repo listing

    /// Child git repos under `<project>/code/` (sorted, hidden entries skipped).
    /// Empty when the project has no `code/` directory.
    static func codeChildRepos(projectRoot: URL) -> [URL] {
        let fm = FileManager.default
        let children = (try? fm.contentsOfDirectory(
            at: ProjectLayout(root: projectRoot).codeDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles])) ?? []
        return children
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}

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
/// more `code/<child>` repos each gets `graph/<child-folder-name>/`.
///
/// Loop worktrees: a Loop run may execute in a linked git worktree. Its generated
/// data belongs to the MAIN checkout, so `mainCheckout(forRepo:)` maps a worktree
/// back to its main repo first. Two layouts are recognised:
/// `<project>/system/loop-worktrees/<id>` (main found via git) and
/// `<parent>/.llmide-loop-worktrees/<repo>/<id>` (main is `<parent>/<repo>`).
///
/// Project-root detection: a path whose parent is named `code` AND whose
/// grandparent holds `system/project.json` is a `code/<child>` repo. Anything else
/// (including a project that happens to live under `~/code/`) is its own root.
enum GeneratedDataLocator {

    // MARK: - Main checkout (Loop worktrees)

    /// The main checkout a path belongs to: the path itself, unless it is a Loop
    /// worktree, in which case the repo the worktree was created from.
    static func mainCheckout(forRepo repo: URL) -> URL {
        let std = repo.standardizedFileURL
        let nameDir = std.deletingLastPathComponent()          // <repo-name>
        let holder = nameDir.deletingLastPathComponent()       // .llmide-loop-worktrees
        if holder.lastPathComponent == ".llmide-loop-worktrees" {
            return holder.deletingLastPathComponent().appendingPathComponent(nameDir.lastPathComponent, isDirectory: true)
        }
        let worktrees = nameDir                                // loop-worktrees
        if worktrees.lastPathComponent == "loop-worktrees",
           worktrees.deletingLastPathComponent().lastPathComponent == "system",
           let main = gitMainCheckout(of: std) {
            return main
        }
        return std
    }

    /// The main checkout git reports for a linked worktree, or nil when `dir` is not one.
    private static func gitMainCheckout(of dir: URL) -> URL? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", dir.path, "rev-parse", "--path-format=absolute", "--git-common-dir"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        do { try process.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              text.hasSuffix("/.git") else { return nil }
        return URL(fileURLWithPath: text).deletingLastPathComponent()
    }

    // MARK: - Project root

    /// The project a repo path belongs to. A Loop worktree maps to its main
    /// checkout first. `<project>/code/<child>` → `<project>`; any other path is
    /// a project root in its own right.
    static func projectRoot(forRepo repo: URL) -> URL {
        projectRootOfMain(mainCheckout(forRepo: repo))
    }

    /// `projectRoot` for a path already known to be a main checkout.
    private static func projectRootOfMain(_ main: URL) -> URL {
        let std = main.standardizedFileURL
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
        let main = mainCheckout(forRepo: repo)
        let project = projectRootOfMain(main)
        let base = ProjectLayout(root: project).graphDir
        guard main.path != project.path else { return base }
        guard codeChildRepos(projectRoot: project).count > 1 else { return base }
        return base.appendingPathComponent(main.lastPathComponent, isDirectory: true)
    }

    // MARK: - Reader locations (new location first, then the other layout, then legacy N-1)

    /// Graph directory to READ from. Candidates, in order, the first that holds a
    /// graph (`index.md` or `graph.json`) wins:
    /// 1. the current location (`graphDir`);
    /// 2. the other layout, so a project that changed from one repo to two (or back)
    ///    keeps its graph readable until the next regeneration re-homes it:
    ///    - one repo now, but a per-repo `graph/<child>/` is left from when there were two;
    ///    - two repos now, and the flat `graph/` is the graph of THIS child (checked
    ///      against the child's own files, so another child's graph is never served);
    /// 3. the pre-D1 `<repo>/system/graph/` (N-1).
    /// Nothing is moved by reading; regeneration writes the current location.
    static func readableGraphDir(forRepo repo: URL) -> URL {
        let main = mainCheckout(forRepo: repo)
        let project = projectRootOfMain(main)
        let current = graphDir(forRepo: main)
        if holdsGraph(current) { return current }

        let flat = ProjectLayout(root: project).graphDir
        if current.path != flat.path {
            // Per-repo now: the flat graph is ours only if its files live in this child.
            if holdsGraph(flat), flatGraphIsOf(main, flat) { return flat }
        } else {
            // Flat now: a per-repo leftover named for this child.
            let perChild = flat.appendingPathComponent(main.lastPathComponent, isDirectory: true)
            if holdsGraph(perChild) { return perChild }
        }

        let legacy = legacySystemDir(forRepo: main).appendingPathComponent("graph", isDirectory: true)
        if holdsGraph(legacy) { return legacy }
        return current
    }

    /// A graph directory holds an overview (`index.md`) or the machine graph (`graph.json`).
    private static func holdsGraph(_ dir: URL) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: dir.appendingPathComponent("index.md").path)
            || fm.fileExists(atPath: dir.appendingPathComponent("graph.json").path)
    }

    /// True when the flat graph's `graph.json` names at least one file that exists in `repo`.
    /// Graph paths are repo-relative, so this tells this child's graph from a sibling's.
    private static func flatGraphIsOf(_ repo: URL, _ flat: URL) -> Bool {
        let json = flat.appendingPathComponent("graph.json")
        guard let data = try? Data(contentsOf: json),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let files = object["files"] as? [[String: Any]] else { return false }
        return files.prefix(50).contains { entry in
            guard let path = entry["path"] as? String, !path.isEmpty, !path.hasPrefix("/") else { return false }
            return FileManager.default.fileExists(atPath: repo.appendingPathComponent(path).path)
        }
    }

    /// The file a reader should use for one memory artifact, merged per file the
    /// same way the server's reader does (`graphkit/memory.mjs` `readMemoryFile`):
    /// the project copy if it exists, else the pre-D1 repo copy, else the
    /// pre-consolidation `graphify-out/memory/` copy. Nil when none exists.
    static func readableMemoryFile(forRepo repo: URL, name: String) -> URL? {
        let fm = FileManager.default
        let main = mainCheckout(forRepo: repo)
        let candidates = [
            memoryDir(forRepo: main).appendingPathComponent(name),
            legacySystemDir(forRepo: main).appendingPathComponent("memory", isDirectory: true).appendingPathComponent(name),
            main.appendingPathComponent("graphify-out", isDirectory: true)
                .appendingPathComponent("memory", isDirectory: true).appendingPathComponent(name),
        ]
        return candidates.first { fm.fileExists(atPath: $0.path) }
    }

    /// Names of the memory artifacts visible to a reader: the union of the three
    /// locations in `readableMemoryFile`, each name once.
    static func readableMemoryFileNames(forRepo repo: URL) -> [String] {
        let main = mainCheckout(forRepo: repo)
        let dirs = [
            memoryDir(forRepo: main),
            legacySystemDir(forRepo: main).appendingPathComponent("memory", isDirectory: true),
            main.appendingPathComponent("graphify-out", isDirectory: true)
                .appendingPathComponent("memory", isDirectory: true),
        ]
        var names = Set<String>()
        for dir in dirs {
            for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] {
                names.insert(name)
            }
        }
        return names.sorted()
    }

    /// The pre-D1 generated-output container inside a repo: `<repo>/system`. Read-only.
    static func legacySystemDir(forRepo repo: URL) -> URL {
        mainCheckout(forRepo: repo).appendingPathComponent("system", isDirectory: true)
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

import Foundation

/// A skill stage's Input/Output resolved to ABSOLUTE locations on the Mac, so
/// the agent is told where to read/write instead of inferring a folder from a
/// relative path and the prompt's resolution rule (which it cannot verify — it
/// cannot read `system/project.json`). Mirrors `LoopStageDetector`'s
/// `resolvePathsRule` / `docResolvePathsRule` exactly:
/// - absolute paths are used as given;
/// - "." is the git root;
/// - doc stages resolve against the git root only;
/// - every other stage: the git root when the Input (or the Output's parent
///   directory) exists there, else the project root when it is an LLM-IDE
///   project (`system/project.json`) and the git root sits 1...3 levels below
///   it, else the git root.
struct LoopStagePaths: Equatable {
    var input: URL?
    var output: URL?

    nonisolated static let docSkillIds: Set<String> = ["skills/doc-structure-index", "skills/doc-writer"]
    nonisolated static let docDefaultKeys: Set<String> = ["doc-index", "doc-writer"]

    nonisolated static func isDocStage(_ stage: LoopStage) -> Bool {
        if let id = stage.skillId, docSkillIds.contains(id) { return true }
        if let key = stage.defaultKey, docDefaultKeys.contains(key) { return true }
        return false
    }

    nonisolated static func resolve(_ stage: LoopStage, gitRoot: URL, projectRoot: URL,
                                    fileManager fm: FileManager = .default) -> LoopStagePaths {
        let repo = gitRoot.standardizedFileURL
        let project = projectRoot.standardizedFileURL
        let useProject = !isDocStage(stage) && isProjectAbove(repo, project: project, fileManager: fm)

        func clean(_ raw: String?) -> String? {
            guard let p = raw?.trimmingCharacters(in: .whitespaces), !p.isEmpty else { return nil }
            return p
        }
        func resolveOne(_ raw: String, checkingParent: Bool) -> URL {
            if raw == "~" || raw.hasPrefix("~/") {
                return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath).standardizedFileURL
            }
            if raw.hasPrefix("/") { return URL(fileURLWithPath: raw).standardizedFileURL }
            if raw == "." { return repo }
            let inRepo = repo.appendingPathComponent(raw).standardizedFileURL
            guard useProject else { return inRepo }
            let probe = checkingParent ? inRepo.deletingLastPathComponent() : inRepo
            if fm.fileExists(atPath: probe.path) { return inRepo }
            return project.appendingPathComponent(raw).standardizedFileURL
        }
        return LoopStagePaths(
            input: clean(stage.targetPath).map { resolveOne($0, checkingParent: false) },
            output: clean(stage.outputPath).map { resolveOne($0, checkingParent: true) })
    }

    /// The project root is an LLM-IDE project and `repo` is 1...3 levels below it.
    nonisolated private static func isProjectAbove(_ repo: URL, project: URL, fileManager fm: FileManager) -> Bool {
        let r = repo.resolvingSymlinksInPath().path
        let p = project.resolvingSymlinksInPath().path
        guard r.hasPrefix(p + "/") else { return false }
        let depth = r.dropFirst(p.count + 1).split(separator: "/").count
        return depth <= 3
            && fm.fileExists(atPath: project.appendingPathComponent("system/project.json").path)
    }

    /// Whether `url` lies inside (or equals) one of `roots`, comparing
    /// standardized, symlink-resolved paths. A not-yet-existing file is
    /// resolved through its nearest existing ancestor.
    nonisolated static func isInside(_ url: URL, roots: [URL]) -> Bool {
        // Case-insensitive (default macOS volumes), like the server's samePath.
        let path = realPath(url).lowercased()
        return roots.contains { root in
            let r = realPath(root).lowercased()
            return path == r || path.hasPrefix(r.hasSuffix("/") ? r : r + "/")
        }
    }

    nonisolated private static func realPath(_ url: URL) -> String {
        var base = url.standardizedFileURL
        var tail: [String] = []
        while !FileManager.default.fileExists(atPath: base.path), base.path != "/" {
            tail.insert(base.lastPathComponent, at: 0)
            base = base.deletingLastPathComponent()
        }
        var resolved = base.resolvingSymlinksInPath()
        for t in tail { resolved.appendPathComponent(t) }
        return resolved.path
    }

    /// A Loop worktree checked out as a sibling of the project (same-root
    /// layout) is deleted with the run: anything under its `llm-doc/` is lost.
    nonisolated static func isSiblingWorktree(_ gitRoot: URL) -> Bool {
        gitRoot.standardizedFileURL.pathComponents.contains(".llmide-loop-worktrees")
    }

    /// Non-doc stages must not write `llm-doc/…` inside a throwaway sibling worktree.
    nonisolated func throwawayProblem(stageName: String, stage: LoopStage, gitRoot: URL) -> String? {
        guard Self.isSiblingWorktree(gitRoot), !Self.isDocStage(stage) else { return nil }
        let doc = gitRoot.appendingPathComponent("llm-doc", isDirectory: true)
        for url in [input, output].compactMap({ $0 }) where Self.isInside(url, roots: [doc]) {
            return "\(stageName) writes to llm-doc/…, which would land in a throwaway worktree — run this loop without a worktree (or check out the repo under code/)"
        }
        return nil
    }

    /// The refusal message for the first path outside the allowed roots, or nil.
    nonisolated func outsideProblem(roots: [URL]) -> String? {
        for (label, url) in [("Input", input), ("Output", output)] {
            if let url, !Self.isInside(url, roots: roots) {
                return "\(label) path \(url.path) is outside the repo and the project's llm-doc — the agent could not use it"
            }
        }
        return nil
    }
}

import Foundation
import os.log

/// One-time, idempotent move of GENERATED data from a cloned repo's own
/// `<repo>/system/` (the pre-D1 location under `code/<child>/`) into the
/// project's `<project>/system/` (see `GeneratedDataLocator`).
///
/// Only files the app itself writes move. Everything else stays where it is:
/// - `graph/`: only when it is a recognised generator output (it holds
///   `graph.json` or `index.md` AND the generator's self-ignore marker `*`).
///   Then `graph.json`, `index.md`, `*.md` per-file notes and the marker move.
/// - `memory/`: only the known artifact names (`graph-notes.md`, `doc-notes.md`,
///   `chat-memory.md`, `environment.md`) and a marker `.gitignore`.
/// - `faults/`, `q&a/`: only files named like the writers' output,
///   `yyyy-MM-ddTHH-mm-ssZ-<slug>.md`.
/// - `repo.md` is hand-authored, so it never moves; readers fall back to it.
///
/// Safety rules:
/// - Git decides first. If the repo's `system/` holds any git-TRACKED file, or
///   git cannot answer (missing, failing, or a nested checkout), the whole repo
///   is skipped and logged. "Not a git repository" is a definite answer: nothing
///   can be tracked there, so migration may proceed on the name rules alone.
/// - Each file is copied, byte-compared against the source, and only then is the
///   source removed (move-after-verify).
/// - Nothing already at the new root is overwritten. A conflicting source file is
///   left where it is, and so is its legacy directory. The N-1 read fallback in
///   `GeneratedDataLocator` keeps that data readable.
///
/// Safe to call on every project open: once the moved files are gone it does nothing.
enum GeneratedDataMigration {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "GeneratedDataMigration")

    /// Legacy entries under `<repo>/system/` that are generated output.
    static let generatedEntries = ["graph", "memory", "faults", "q&a"]
    /// The memory artifacts the app writes into `system/memory/`.
    static let memoryArtifacts: Set<String> = ["graph-notes.md", "doc-notes.md", "chat-memory.md", "environment.md"]
    /// Git executables tried in order (PATH-independent). The first that exists is used.
    static let gitCandidates = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]

    /// Result of one run, so callers and tests can see what happened.
    struct Report: Equatable {
        var movedRepos: [String] = []
        /// Repos skipped because their `system/` holds git-tracked files.
        var skippedTrackedRepos: [String] = []
        /// Repos skipped because git could not answer, or the data sits in a nested checkout.
        var skippedUnsafeRepos: [String] = []
        /// Generated-looking files left in place because a file already sat at the new root.
        var conflicts: [String] = []
        /// Files under a legacy entry that are not recognised as generated, left in place.
        var unrecognised: [String] = []
    }

    /// What git says about a repo's legacy `system/`.
    enum GitStatus: Equatable {
        /// Safe to migrate: either not a git repo, or git ran and nothing is tracked there.
        case clean
        case tracked([String])
        case unsafe(String)
    }

    @discardableResult
    static func run(in projectRoot: URL, gitCandidates: [String] = gitCandidates) -> Report {
        var report = Report()
        let fm = FileManager.default
        let layout = ProjectLayout(root: projectRoot)
        let children = GeneratedDataLocator.codeChildRepos(projectRoot: projectRoot)
        let multi = children.count > 1

        for child in children {
            let legacy = GeneratedDataLocator.legacySystemDir(forRepo: child)
            guard fm.fileExists(atPath: legacy.path) else { continue }

            // Plan first. Nothing moves unless the repo passes the git check.
            var plan: [(src: URL, dst: URL)] = []
            for entry in generatedEntries {
                let legacyEntry = legacy.appendingPathComponent(entry, isDirectory: true)
                guard fm.fileExists(atPath: legacyEntry.path) else { continue }
                let destRoot = destination(for: entry, child: child, multi: multi, layout: layout)
                let (files, unknown) = recognisedFiles(entry: entry, legacyEntry: legacyEntry)
                report.unrecognised += unknown.map { "\(child.lastPathComponent)/\(entry)/\(relative($0, to: legacyEntry))" }
                for src in files {
                    plan.append((src, destRoot.appendingPathComponent(relative(src, to: legacyEntry))))
                }
            }
            guard !plan.isEmpty else { continue }

            let entryDirs = generatedEntries.map { legacy.appendingPathComponent($0, isDirectory: true) }
                .filter { fm.fileExists(atPath: $0.path) }
            switch gitStatus(repo: child, legacySystem: legacy, entryDirs: entryDirs, candidates: gitCandidates) {
            case .unsafe(let reason):
                log.info("Skipping generated-data move for \(child.lastPathComponent, privacy: .public): \(reason, privacy: .public)")
                report.skippedUnsafeRepos.append(child.lastPathComponent)
                continue
            case .tracked:
                log.info("Skipping generated-data move for \(child.lastPathComponent, privacy: .public): system/ holds git-tracked files.")
                report.skippedTrackedRepos.append(child.lastPathComponent)
                continue
            case .clean:
                break
            }

            let conflictsBefore = report.conflicts.count
            for step in plan {
                moveFile(from: step.src, to: step.dst, report: &report, repo: child.lastPathComponent)
            }
            for entry in generatedEntries {
                pruneEmptyDirectories(under: legacy.appendingPathComponent(entry, isDirectory: true))
            }
            // Drop the legacy system/ only when this run emptied it.
            if let rest = try? fm.contentsOfDirectory(atPath: legacy.path), rest.isEmpty {
                try? fm.removeItem(at: legacy)
            }
            if report.conflicts.count == conflictsBefore {
                report.movedRepos.append(child.lastPathComponent)
                log.info("Moved generated data from \(child.lastPathComponent, privacy: .public)/system into the project system/.")
            }
        }
        return report
    }

    // MARK: - Destinations and recognition

    private static func destination(for entry: String, child: URL, multi: Bool, layout: ProjectLayout) -> URL {
        switch entry {
        case "graph":
            return multi
                ? layout.graphDir.appendingPathComponent(child.lastPathComponent, isDirectory: true)
                : layout.graphDir
        case "memory": return layout.memoryDir
        case "faults": return layout.faultsDir
        default: return layout.systemDir.appendingPathComponent("q&a", isDirectory: true)
        }
    }

    /// The files under one legacy entry that the app generated, and the rest.
    static func recognisedFiles(entry: String, legacyEntry: URL) -> (files: [URL], unrecognised: [URL]) {
        let fm = FileManager.default
        switch entry {
        case "graph":
            let all = filesRecursively(under: legacyEntry)
            let marker = legacyEntry.appendingPathComponent(".gitignore")
            let holdsGraph = fm.fileExists(atPath: legacyEntry.appendingPathComponent("graph.json").path)
                || fm.fileExists(atPath: legacyEntry.appendingPathComponent("index.md").path)
            guard holdsGraph, isIgnoreMarker(marker, allowed: []) else { return ([], all) }
            var files: [URL] = []
            var unknown: [URL] = []
            for url in all {
                let name = url.lastPathComponent
                let generated = name == "graph.json" || name == "index.md" || name.hasSuffix(".md")
                    || (relative(url, to: legacyEntry) == ".gitignore" && isIgnoreMarker(url, allowed: []))
                if generated { files.append(url) } else { unknown.append(url) }
            }
            return (files, unknown)
        case "memory":
            return splitDirectChildren(of: legacyEntry) { name, url in
                memoryArtifacts.contains(name)
                    || (name == ".gitignore" && isIgnoreMarker(url, allowed: memoryArtifacts))
            }
        default: // faults, q&a
            return splitDirectChildren(of: legacyEntry) { name, url in
                !isDirectory(url) && isTimestampedNote(name)
            }
        }
    }

    /// `yyyy-MM-ddTHH-mm-ssZ-<slug>.md`, the name every fault and Q&A writer uses.
    static func isTimestampedNote(_ name: String) -> Bool {
        name.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-.+\.md$"#, options: .regularExpression) != nil
    }

    /// A self-ignore marker: non-empty lines, each `*` or one of `allowed`, with `*` present.
    static func isIgnoreMarker(_ url: URL, allowed: Set<String>) -> Bool {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return false }
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return lines.contains("*") && lines.allSatisfy { $0 == "*" || allowed.contains($0) }
    }

    private static func splitDirectChildren(of dir: URL,
                                            _ isGenerated: (String, URL) -> Bool) -> (files: [URL], unrecognised: [URL]) {
        let children = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil, options: [])) ?? []
        var files: [URL] = []
        var unknown: [URL] = []
        for url in children {
            if isGenerated(url.lastPathComponent, url) { files.append(url) } else { unknown.append(url) }
        }
        return (files, unknown)
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    /// Every regular file under `dir`, recursively (hidden files included).
    private static func filesRecursively(under dir: URL) -> [URL] {
        guard let enumerator = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isDirectoryKey]) else {
            return []
        }
        var result: [URL] = []
        for case let url as URL in enumerator where !isDirectory(url) { result.append(url) }
        return result.sorted { $0.path < $1.path }
    }

    private static func relative(_ url: URL, to base: URL) -> String {
        let prefix = base.standardizedFileURL.path + "/"
        let path = url.standardizedFileURL.path
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : url.lastPathComponent
    }

    // MARK: - Moves

    /// Copies `src` to `dst`, byte-compares, then removes `src`. Never overwrites.
    private static func moveFile(from src: URL, to dst: URL, report: inout Report, repo: String) {
        let fm = FileManager.default
        if fm.fileExists(atPath: dst.path) {
            // Both are the same generated `.gitignore` marker: the source is safe to drop.
            if src.lastPathComponent == ".gitignore",
               let a = try? Data(contentsOf: src), let b = try? Data(contentsOf: dst), a == b {
                try? fm.removeItem(at: src)
                return
            }
            report.conflicts.append("\(repo)/\(src.lastPathComponent)")
            log.info("Kept \(src.path, privacy: .public): a file already exists at the project's new location.")
            return
        }
        do {
            try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.copyItem(at: src, to: dst)
            let original = try Data(contentsOf: src)
            let copied = try Data(contentsOf: dst)
            guard original == copied else {
                try? fm.removeItem(at: dst)
                report.conflicts.append("\(repo)/\(src.lastPathComponent)")
                log.error("Verify failed copying \(src.path, privacy: .public); source kept.")
                return
            }
            try fm.removeItem(at: src)
        } catch {
            report.conflicts.append("\(repo)/\(src.lastPathComponent)")
            log.error("Generated-data move failed for \(src.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Removes directories under `dir` (deepest first) that are now empty, and `dir` itself.
    private static func pruneEmptyDirectories(under dir: URL) {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: dir, includingPropertiesForKeys: [.isDirectoryKey]) else { return }
        var dirs: [URL] = []
        for case let url as URL in enumerator where isDirectory(url) { dirs.append(url) }
        for url in dirs.sorted(by: { $0.path.count > $1.path.count }) {
            if let rest = try? fm.contentsOfDirectory(atPath: url.path), rest.isEmpty {
                try? fm.removeItem(at: url)
            }
        }
        if let rest = try? fm.contentsOfDirectory(atPath: dir.path), rest.isEmpty {
            try? fm.removeItem(at: dir)
        }
    }

    // MARK: - Git

    /// Decides whether git says the repo's legacy `system/` is safe to move.
    ///
    /// - No git executable at a known location: unsafe (we cannot check).
    /// - Nothing being moved is in any work tree: clean.
    /// - Something being moved is in a work tree other than the repo's (a nested
    ///   checkout, or a plain folder inside someone else's checkout): unsafe.
    /// - Otherwise any git-tracked file under `system/` makes the repo tracked.
    static func gitStatus(repo: URL, legacySystem: URL, entryDirs: [URL],
                          candidates: [String] = gitCandidates) -> GitStatus {
        guard let git = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return .unsafe("no git executable at a known location; not migrating")
        }
        let repoTop: String?
        switch topLevel(git: git, of: repo) {
        case .unsafe(let reason): return .unsafe(reason)
        case .top(let top): repoTop = top
        case .notRepo: repoTop = nil
        }
        // Every directory we would move from must sit in the repo's own work tree
        // (or in none). A nested checkout anywhere in there owns its own files.
        var anyInWorkTree = false
        for dir in [legacySystem] + entryDirs {
            switch topLevel(git: git, of: dir) {
            case .unsafe(let reason): return .unsafe(reason)
            case .notRepo: continue
            case .top(let top):
                guard top == repoTop else {
                    return .unsafe("\(dir.lastPathComponent) is inside a git checkout other than the repo's (nested checkout); not migrating")
                }
                anyInWorkTree = true
            }
        }
        guard anyInWorkTree else { return .clean }
        switch runGit(git, ["-C", repo.path, "ls-files", "-z", "--", "system"]) {
        case .launchFailed:
            return .unsafe("could not start git; not migrating")
        case .exited(let status, let out, let err):
            guard status == 0 else {
                return .unsafe("git ls-files failed (\(status)): \(err.trimmingCharacters(in: .whitespacesAndNewlines)); not migrating")
            }
            let tracked = out.split(separator: "\0").map(String.init)
            return tracked.isEmpty ? .clean : .tracked(tracked)
        }
    }

    private enum TopLevel {
        case top(String)
        case notRepo
        case unsafe(String)
    }

    /// The work-tree root containing `dir`, or `.notRepo` when git says so.
    private static func topLevel(git: String, of dir: URL) -> TopLevel {
        switch runGit(git, ["-C", dir.path, "rev-parse", "--show-toplevel"]) {
        case .launchFailed:
            return .unsafe("could not start git; not migrating")
        case .exited(let status, let out, let err):
            if status == 0 {
                return .top(out.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            if err.contains("not a git repository") { return .notRepo }
            return .unsafe("git rev-parse failed (\(status)): \(err.trimmingCharacters(in: .whitespacesAndNewlines)); not migrating")
        }
    }

    private enum GitRun {
        case launchFailed
        case exited(Int32, String, String)
    }

    private static func runGit(_ git: String, _ args: [String]) -> GitRun {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: git)
        process.arguments = args
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        do { try process.run() } catch { return .launchFailed }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return .exited(process.terminationStatus,
                       String(data: outData, encoding: .utf8) ?? "",
                       String(data: errData, encoding: .utf8) ?? "")
    }
}

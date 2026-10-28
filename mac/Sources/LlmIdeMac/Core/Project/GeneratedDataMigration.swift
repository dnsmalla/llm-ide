import Foundation
import os.log

/// One-time, idempotent move of generated data from a cloned repo's own
/// `<repo>/system/` (the pre-D1 location under `code/<child>/`) into the
/// project's `<project>/system/` (see `GeneratedDataLocator`).
///
/// Moved: `graph/` (into `graph/<child>/` when the project has 2+ code repos),
/// `memory/`, `faults/`, `q&a/`, and `repo.md`.
///
/// Safety rules:
/// - A repo whose `system/` holds any git-TRACKED file is skipped entirely and
///   logged: that is user content, not generated output.
/// - Each file is copied, byte-compared against the source, and only then is the
///   source removed (move-after-verify).
/// - Nothing already at the new root is overwritten. A conflicting source file is
///   left where it is, and so is its legacy directory. The N-1 read fallback in
///   `GeneratedDataLocator` keeps that data readable.
/// - Only directories this run emptied are removed. A `.gitignore` marker of
///   exactly `*\n` that conflicts with a new-root marker is dropped, since both are
///   the same generated marker.
///
/// Safe to call on every project open: once the legacy directories are gone it
/// does nothing.
enum GeneratedDataMigration {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "GeneratedDataMigration")

    /// Entries under a legacy `<repo>/system/` that belong to the project now.
    static let movedEntries = ["graph", "memory", "faults", "q&a", "repo.md"]

    /// Result of one run, so callers and tests can see what happened.
    struct Report: Equatable {
        var movedRepos: [String] = []
        var skippedTrackedRepos: [String] = []
        var conflicts: [String] = []
    }

    @discardableResult
    static func run(in projectRoot: URL) -> Report {
        var report = Report()
        let fm = FileManager.default
        let layout = ProjectLayout(root: projectRoot)
        let children = GeneratedDataLocator.codeChildRepos(projectRoot: projectRoot)
        let multi = children.count > 1

        for child in children {
            let legacy = GeneratedDataLocator.legacySystemDir(forRepo: child)
            let present = movedEntries.filter { fm.fileExists(atPath: legacy.appendingPathComponent($0).path) }
            guard !present.isEmpty else { continue }

            if !gitTrackedFiles(under: legacy, repo: child).isEmpty {
                log.info("Skipping generated-data move for \(child.lastPathComponent, privacy: .public): system/ holds git-tracked files.")
                report.skippedTrackedRepos.append(child.lastPathComponent)
                continue
            }

            let conflictsBefore = report.conflicts.count
            for name in present {
                let dest: URL
                switch name {
                case "graph":
                    dest = multi
                        ? layout.graphDir.appendingPathComponent(child.lastPathComponent, isDirectory: true)
                        : layout.graphDir
                case "memory": dest = layout.memoryDir
                case "faults": dest = layout.faultsDir
                case "q&a": dest = layout.systemDir.appendingPathComponent("q&a", isDirectory: true)
                default: dest = layout.systemDir.appendingPathComponent(name)
                }
                moveTree(from: legacy.appendingPathComponent(name), to: dest,
                         report: &report, repo: child.lastPathComponent)
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

    // MARK: - Tree move

    /// Moves `src` (file or directory) to `dst`, file by file. Returns nothing;
    /// failures are logged and recorded as conflicts.
    private static func moveTree(from src: URL, to dst: URL, report: inout Report, repo: String) {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: src.path, isDirectory: &isDir) else { return }

        if !isDir.boolValue {
            moveFile(from: src, to: dst, report: &report, repo: repo)
            return
        }
        let entries = (try? fm.contentsOfDirectory(at: src, includingPropertiesForKeys: nil, options: [])) ?? []
        for entry in entries {
            moveTree(from: entry, to: dst.appendingPathComponent(entry.lastPathComponent),
                     report: &report, repo: repo)
        }
        if let rest = try? fm.contentsOfDirectory(atPath: src.path), rest.isEmpty {
            try? fm.removeItem(at: src)
        }
    }

    private static func moveFile(from src: URL, to dst: URL, report: inout Report, repo: String) {
        let fm = FileManager.default
        if fm.fileExists(atPath: dst.path) {
            // Both are the same generated `.gitignore` marker: the source is safe to drop.
            if src.lastPathComponent == ".gitignore",
               (try? Data(contentsOf: src)) == Data("*\n".utf8) {
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

    // MARK: - Git

    /// Git-tracked paths under `dir` (empty when `repo` is not a git work tree or
    /// nothing under `dir` is tracked).
    static func gitTrackedFiles(under dir: URL, repo: URL) -> [String] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo.path, "ls-files", "--", dir.lastPathComponent]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do { try process.run() } catch { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return [] }
        return (String(data: data, encoding: .utf8) ?? "")
            .split(whereSeparator: \.isNewline).map(String.init)
    }
}

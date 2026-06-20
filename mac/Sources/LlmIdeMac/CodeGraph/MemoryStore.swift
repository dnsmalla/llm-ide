// Read/write the Understand-Anything memory dir under <repo>/.understand-anything/memory/.
//
// Phase A surface — seed + read only:
//   • seedIfMissing(in:) creates the dir layout and a templated
//     repo.md if it doesn't exist. Idempotent — user edits to
//     repo.md are preserved on subsequent seeds.
//   • loadRepoNotes / saveRepoNotes for the curated repo.md.
//   • listFaults / listQA enumerate markdown files in the
//     faults/ and q&a/ subdirs for the UI to display.
//
// Write methods for faults (phase B) and Q&A (phase C) live in this
// same type but are added in their respective plans.

import Foundation

public struct MemoryStore {
    /// Subdir under the repo where memory files live. Defaults to
    /// the conventional `.understand-anything/memory`; tests + callers can
    /// override it. Settings UI rejects absolute paths and `..`
    /// segments via PathValidator.memorySubdir, so by the time a
    /// value lands here it's always a clean relative path.
    public let memorySubdir: String

    public init(memorySubdir: String = ".understand-anything/memory") {
        // Be defensive — if a caller forgets to validate, fall back
        // to the convention rather than blowing up at the FS layer.
        let trimmed = memorySubdir.trimmingCharacters(in: .whitespaces)
        self.memorySubdir = trimmed.isEmpty ? ".understand-anything/memory" : trimmed
    }

    // MARK: - Paths

    private func memoryDir(in repo: URL) -> URL {
        var url = repo
        for segment in memorySubdir.split(separator: "/", omittingEmptySubsequences: true) {
            url = url.appendingPathComponent(String(segment), isDirectory: true)
        }
        return url
    }

    private func faultsDir(in repo: URL) -> URL  { memoryDir(in: repo).appendingPathComponent("faults", isDirectory: true) }
    /// Pre-rename location of the faults dir. Only used by the one-time
    /// migration in `seedIfMissing` so existing on-disk archives move
    /// over to the new `faults/` name.
    private func legacyFaultsDir(in repo: URL) -> URL { memoryDir(in: repo).appendingPathComponent("bugs", isDirectory: true) }
    private func qaDir(in repo: URL)   -> URL  { memoryDir(in: repo).appendingPathComponent("q&a",   isDirectory: true) }
    private func repoNotesURL(in repo: URL) -> URL { memoryDir(in: repo).appendingPathComponent("repo.md") }

    // MARK: - Seed

    /// Idempotent. Creates memory/, memory/faults/, memory/q&a/ if absent,
    /// and writes repo.md from the template if (and only if) it doesn't
    /// already exist. User edits to repo.md are never overwritten.
    ///
    /// One-time migration: when the legacy `bugs/` dir exists but the
    /// new `faults/` dir does not, the directory is moved in place so
    /// existing archives carry over under the renamed terminology.
    public func seedIfMissing(in repo: URL) throws {
        let fm = FileManager.default
        let legacy = legacyFaultsDir(in: repo)
        let faults = faultsDir(in: repo)
        if !fm.fileExists(atPath: faults.path), fm.fileExists(atPath: legacy.path) {
            try fm.moveItem(at: legacy, to: faults)
        }
        for dir in [memoryDir(in: repo), faults, qaDir(in: repo)] {
            if !fm.fileExists(atPath: dir.path) {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            }
        }
        let repoMd = repoNotesURL(in: repo)
        if !fm.fileExists(atPath: repoMd.path) {
            try Self.repoTemplate.write(to: repoMd, atomically: true, encoding: .utf8)
        }
    }

    // MARK: - List

    /// Sorted ascending by file name (date-prefixed slugs naturally
    /// order chronologically). Only `.md` files are returned; non-markdown
    /// files in the dir are ignored.
    public func listFaults(at repo: URL) -> [URL] { listMarkdown(in: faultsDir(in: repo)) }
    public func listQA(at repo: URL)   -> [URL] { listMarkdown(in: qaDir(in: repo)) }

    private func listMarkdown(in dir: URL) -> [URL] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            return []
        }
        return entries
            .filter { $0.pathExtension.lowercased() == "md" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    // MARK: - Fault writes (Phase B)

    /// Write a new fault report under `<repo>/.understand-anything/memory/faults/`.
    /// File name comes from `fault.suggestedFileName()` (ISO timestamp +
    /// slug) so listings naturally sort chronologically. Creates the
    /// faults/ dir if needed; throws on FS errors or YAML serialisation
    /// failures.
    @discardableResult
    func writeFault(at repo: URL, _ fault: FaultReport) throws -> URL {
        let dir = faultsDir(in: repo)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(fault.suggestedFileName())
        let md = try fault.toMarkdown()
        try md.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func loadFault(at url: URL) throws -> FaultReport {
        let md = try String(contentsOf: url, encoding: .utf8)
        return try FaultReport.fromMarkdown(md)
    }

    /// In-place status flip. Reads the file, rewrites only the status
    /// frontmatter field, and writes back atomically. Notes body and
    /// other frontmatter fields are byte-preserved so user edits in
    /// other tools aren't disturbed.
    func updateFaultStatus(at url: URL, to newStatus: FaultStatus) throws {
        let old = try String(contentsOf: url, encoding: .utf8)
        let updated = try FaultReport.rewritingStatus(in: old, to: newStatus)
        try updated.write(to: url, atomically: true, encoding: .utf8)
    }

    /// Flip status to `.fixed` and attach a verify command in one write.
    /// When `command` is nil only the status changes.
    func markFixed(at url: URL, verify command: String?) throws {
        var fault = try loadFault(at: url)
        fault.status = .fixed
        if let command { fault.verify = command; fault.verifyKind = .command }
        let md = try fault.toMarkdown()
        try md.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: - Faults registry (CSV export)

    /// Export every fault (all statuses) under the faults dir to a flat
    /// `<repo>/<memorySubdir>/faults.csv` registry and return its URL.
    ///
    /// One row per `.md` fault file, sorted ascending by file name.
    /// Columns: reported, severity, status, fault, answer, git_head,
    /// app_version, agent, file. Free-text cells (the prompt + response)
    /// are whitespace-collapsed and capped so the registry stays
    /// spreadsheet-friendly; every cell is CSV-escaped (wrapped in
    /// double quotes, with internal quotes doubled).
    @discardableResult
    func exportFaultsCSV(at repo: URL) throws -> URL {
        let header = "reported,severity,status,fault,answer,verify,git_head,app_version,agent,file"
        let urls = listFaults(at: repo)   // already sorted ascending by file name
        var lines = [header]
        for url in urls {
            guard let fault = try? loadFault(at: url) else { continue }
            let reported = String(FaultReport.isoFormatter.string(from: fault.reportedAt).prefix(10))
            let cells = [
                reported,
                fault.severity.rawValue,
                fault.status.rawValue,
                Self.shorten(fault.prompt),
                Self.shorten(fault.response),
                Self.shorten(fault.verify ?? ""),
                fault.gitHead ?? "",
                fault.appVersion,
                fault.agent,
                url.lastPathComponent,
            ]
            lines.append(cells.map(Self.csvEscape).joined(separator: ","))
        }
        let csv = lines.joined(separator: "\n") + "\n"
        let url = memoryDir(in: repo).appendingPathComponent("faults.csv")
        try FileManager.default.createDirectory(at: memoryDir(in: repo),
                                                withIntermediateDirectories: true)
        try csv.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    /// Collapse runs of whitespace (incl. newlines/tabs) to single
    /// spaces and cap at ~140 chars so long prompts/responses don't
    /// blow out a spreadsheet row or smuggle raw newlines into the CSV.
    private static func shorten(_ s: String, limit: Int = 140) -> String {
        let collapsed = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return collapsed.count > limit ? String(collapsed.prefix(limit)) : collapsed
    }

    /// RFC-4180-style cell escape: always wrap in double quotes and
    /// double any internal quotes. Wrapping unconditionally keeps the
    /// column count stable even for cells that contain commas.
    private static func csvEscape(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    // MARK: - Working-tree diff (for repair review)

    struct GitDiff: Equatable {
        let unified: String
        let changedPaths: [String]
    }

    /// Unified diff of the working tree vs HEAD, plus the changed paths.
    /// Best-effort: throws only if git can't be launched.
    func gitDiff(at repo: URL) throws -> GitDiff {
        let unified = try Self.runGit(["-C", repo.path, "diff"], at: repo)
        let names = try Self.runGit(["-C", repo.path, "diff", "--name-only"], at: repo)
        let paths = names.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        return GitDiff(unified: unified, changedPaths: paths)
    }

    /// Revert the given working-tree paths to HEAD. Used by "Discard" in
    /// the repair-review UI.
    func gitCheckout(at repo: URL, paths: [String]) throws {
        guard !paths.isEmpty else { return }
        _ = try Self.runGit(["-C", repo.path, "checkout", "--"] + paths, at: repo)
    }

    private static func runGit(_ args: [String], at repo: URL) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = args
        p.currentDirectoryURL = repo
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    // MARK: - Q&A writes (Phase C)

    /// Write a saved Q&A under `<repo>/.understand-anything/memory/q&a/`.
    /// Same naming convention as faults — ISO timestamp + slug, so
    /// directory listings are chronological.
    @discardableResult
    func writeQA(at repo: URL, _ entry: QAEntry) throws -> URL {
        let dir = qaDir(in: repo)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(entry.suggestedFileName())
        let md = try entry.toMarkdown()
        try md.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    // MARK: - Template

    static let repoTemplate = """
    # Project facts

    Edit this file with anything the agent should know about this repo —
    architecture, conventions, gotchas, where things live. The agent reads
    it on every prompt via the Understand-Anything skill.

    > ⚠️ Don't paste secrets here. This file is checked in alongside the
    > rest of the .understand-anything/ dir.

    ## Stack

    (e.g. Swift 5.9, macOS 14+, SPM)

    ## Conventions

    (e.g. tests live in Tests/<Target>Tests/, services in Sources/<Target>/Services/)

    ## Gotchas

    (things that surprised you the first time)
    """
}

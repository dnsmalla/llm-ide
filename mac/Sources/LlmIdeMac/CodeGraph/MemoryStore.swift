// Read/write the Understand-Anything memory dir under <repo>/.understand-anything/memory/.
//
// Phase A surface — seed + read only:
//   • seedIfMissing(in:) creates the dir layout and a templated
//     repo.md if it doesn't exist. Idempotent — user edits to
//     repo.md are preserved on subsequent seeds.
//   • loadRepoNotes / saveRepoNotes for the curated repo.md.
//   • listBugs / listQA enumerate markdown files in the
//     bugs/ and q&a/ subdirs for the UI to display.
//
// Write methods for bugs (phase B) and Q&A (phase C) live in this
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

    private func bugsDir(in repo: URL) -> URL  { memoryDir(in: repo).appendingPathComponent("bugs",  isDirectory: true) }
    private func qaDir(in repo: URL)   -> URL  { memoryDir(in: repo).appendingPathComponent("q&a",   isDirectory: true) }
    private func repoNotesURL(in repo: URL) -> URL { memoryDir(in: repo).appendingPathComponent("repo.md") }

    // MARK: - Seed

    /// Idempotent. Creates memory/, memory/bugs/, memory/q&a/ if absent,
    /// and writes repo.md from the template if (and only if) it doesn't
    /// already exist. User edits to repo.md are never overwritten.
    public func seedIfMissing(in repo: URL) throws {
        let fm = FileManager.default
        for dir in [memoryDir(in: repo), bugsDir(in: repo), qaDir(in: repo)] {
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
    public func listBugs(at repo: URL) -> [URL] { listMarkdown(in: bugsDir(in: repo)) }
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

    // MARK: - Bug writes (Phase B)

    /// Write a new bug report under `<repo>/.understand-anything/memory/bugs/`.
    /// File name comes from `bug.suggestedFileName()` (ISO timestamp +
    /// slug) so listings naturally sort chronologically. Creates the
    /// bugs/ dir if needed; throws on FS errors or YAML serialisation
    /// failures.
    @discardableResult
    func writeBug(at repo: URL, _ bug: BugReport) throws -> URL {
        let dir = bugsDir(in: repo)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(bug.suggestedFileName())
        let md = try bug.toMarkdown()
        try md.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func loadBug(at url: URL) throws -> BugReport {
        let md = try String(contentsOf: url, encoding: .utf8)
        return try BugReport.fromMarkdown(md)
    }

    /// In-place status flip. Reads the file, rewrites only the status
    /// frontmatter field, and writes back atomically. Notes body and
    /// other frontmatter fields are byte-preserved so user edits in
    /// other tools aren't disturbed.
    func updateBugStatus(at url: URL, to newStatus: BugStatus) throws {
        let old = try String(contentsOf: url, encoding: .utf8)
        let updated = try BugReport.rewritingStatus(in: old, to: newStatus)
        try updated.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: - Q&A writes (Phase C)

    /// Write a saved Q&A under `<repo>/.understand-anything/memory/q&a/`.
    /// Same naming convention as bugs — ISO timestamp + slug, so
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

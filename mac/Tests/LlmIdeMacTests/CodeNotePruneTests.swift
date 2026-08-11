import XCTest
@testable import LlmIdeMacLib

/// `pruneOrphanNotes` removes per-file notes whose source file is gone. It runs
/// on every generation, immediately after the notes are written.
final class CodeNotePruneTests: XCTestCase {

    private var root: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("prune-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: root)
    }

    private func note(_ rel: String) throws {
        let url = root.appendingPathComponent(rel)
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "note".write(to: url, atomically: true, encoding: .utf8)
    }

    private func exists(_ rel: String) -> Bool {
        fm.fileExists(atPath: root.appendingPathComponent(rel).path)
    }

    /// The regression: a note for a source file in a SUBDIRECTORY was deleted on
    /// the same run that wrote it, because the note's repo-relative path was
    /// reduced to its last component before being matched against the valid set
    /// ("src/Database.swift.md" → "Database.swift" ∉ { "src/Database.swift" }).
    /// Root-level notes matched and survived, which is why the bug hid: on a
    /// real repo essentially every source file is nested, so the per-file notes
    /// feature silently produced nothing.
    func testNotesForNestedSourceFilesSurvive() throws {
        try note("README.md.md")
        try note("src/Database.swift.md")
        try note("src/deep/nested/Thing.swift.md")

        CodeNoteGenerator.pruneOrphanNotes(notesRoot: root, validPaths: [
            "README.md", "src/Database.swift", "src/deep/nested/Thing.swift",
        ])

        XCTAssertTrue(exists("README.md.md"))
        XCTAssertTrue(exists("src/Database.swift.md"), "a nested note was deleted on the run that created it")
        XCTAssertTrue(exists("src/deep/nested/Thing.swift.md"))
    }

    func testNotesForDeletedSourceFilesArePruned() throws {
        try note("src/Gone.swift.md")
        try note("src/Kept.swift.md")

        CodeNoteGenerator.pruneOrphanNotes(notesRoot: root, validPaths: ["src/Kept.swift"])

        XCTAssertFalse(exists("src/Gone.swift.md"), "orphan note must be removed")
        XCTAssertTrue(exists("src/Kept.swift.md"))
    }

    /// The generator's own sibling outputs live in the same directory and must
    /// not be mistaken for orphaned notes.
    func testGeneratorOwnOutputIsNotPruned() throws {
        try note("index.md")
        CodeNoteGenerator.pruneOrphanNotes(notesRoot: root, validPaths: ["src/A.swift"])
        XCTAssertTrue(exists("index.md"), "index.md must not be pruned as an orphan note")
    }
}

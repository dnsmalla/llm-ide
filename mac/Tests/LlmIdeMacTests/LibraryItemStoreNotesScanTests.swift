import Testing
import Foundation
@testable import LlmIdeMacLib

/// Pins the LLM Doc scan behavior: NoteService writes generated notes to
/// `llm-doc/<source>/<YYYY>/<MM>/*.md`, and the Library must present that
/// real hierarchy. The regression: `folderOrigin` was the immediate parent
/// dir name only, so every note grouped under a bare month ("08") at the
/// section's top level, with no source or year anywhere.
@MainActor
struct LibraryItemStoreNotesScanTests {

    private func makeProject() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-notesscan-\(UUID().uuidString)")
        let month = root.appendingPathComponent("llm-doc/emails/2026/08")
        try FileManager.default.createDirectory(at: month, withIntermediateDirectories: true)
        try Data("note".utf8).write(to: month.appendingPathComponent("2026-08-22-mail.md"))
        try Data("{}".utf8).write(to: root.appendingPathComponent("llm-doc/index.json"))
        try Data("loose".utf8).write(to: root.appendingPathComponent("llm-doc/readme.md"))
        return root
    }

    @Test("a note nested at <source>/<YYYY>/<MM>/ carries the full tree path, not a bare month")
    func nestedNoteTreePath() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }

        let items = LibraryItemStore.performScan(root: root, externalFolders: [])
        let note = try #require(items.first { $0.name == "2026-08-22-mail.md" })
        #expect(note.category == .notes)
        #expect(note.treePath == ["emails", "2026", "08"])
        // Flat consumers (LibraryPicker, Doc Gen) label by folderOrigin — it
        // must carry the whole relative path, not just "08".
        #expect(note.folderOrigin == "emails/2026/08")
    }

    @Test("NoteService's index.json never surfaces as an LLM Doc item")
    func indexJsonExcluded() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }

        let items = LibraryItemStore.performScan(root: root, externalFolders: [])
        #expect(!items.contains { $0.name == "index.json" })
    }

    @Test("a file directly in llm-doc/ stays a loose top-level item")
    func looseFileHasNoFolderOrigin() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }

        let items = LibraryItemStore.performScan(root: root, externalFolders: [])
        let loose = try #require(items.first { $0.name == "readme.md" })
        #expect(loose.folderOrigin == nil)
        #expect(loose.treePath == [])
    }
}

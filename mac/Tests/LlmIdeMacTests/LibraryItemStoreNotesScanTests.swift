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

    @Test("NoteService's ROOT index.json never surfaces; a nested index.json is user data and stays visible")
    func indexJsonExcludedAtRootOnly() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }
        // NoteService only ever writes llm-doc/index.json; a nested one is
        // somebody's data (e.g. an exported metadata file) — hiding it would
        // make an Add File appear to silently fail.
        try Data("{}".utf8).write(
            to: root.appendingPathComponent("llm-doc/emails/2026/08/index.json"))

        let items = LibraryItemStore.performScan(root: root, externalFolders: [])
        let indexItems = items.filter { $0.name == "index.json" }
        #expect(indexItems.count == 1)
        #expect(indexItems.first?.treePath == ["emails", "2026", "08"])
    }

    @Test("tree-entry directory ids are namespaced per category, so a CODE repo and an llm-doc dir sharing a name can't collide in one List")
    func treeEntryIdsAreNamespaced() {
        var code = LibraryItem(name: "a.swift", path: "/p/code/documents/a.swift", category: .code)
        code.treePath = ["documents"]
        var note = LibraryItem(name: "b.md", path: "/p/llm-doc/documents/b.md", category: .notes)
        note.treePath = ["documents"]

        let codeIds = CodeEntry.build(from: [code], idPrefix: "Code:").map(\.id)
        let noteIds = CodeEntry.build(from: [note], idPrefix: "Notes:").map(\.id)
        #expect(codeIds == ["dir:Code:documents"])
        #expect(noteIds == ["dir:Notes:documents"])
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

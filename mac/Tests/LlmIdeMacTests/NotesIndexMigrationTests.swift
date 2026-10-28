import Foundation
import Testing
@testable import LlmIdeMacLib

/// D6: the note index moves from `llm-doc/index.json` to `system/cache/notes-index.json`.
/// Fixtures in `Fixtures/notes-d6/` are the pre-D6 NoteIndex encoder output.
@Suite("NotesIndexMigration (D6: note index out of llm-doc)")
struct NotesIndexMigrationTests {

    private func fixture(_ name: String) throws -> Data {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/notes-d6", isDirectory: true)
            .appendingPathComponent(name)
        return try Data(contentsOf: url)
    }

    private func tmpProject() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("notes-d6-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("llm-doc"), withIntermediateDirectories: true)
        return root
    }

    private func writeLegacy(_ data: Data, in root: URL) throws {
        try data.write(to: ProjectLayout(root: root).legacyNotesIndex)
    }

    private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

    private func decodeIndex(_ url: URL) throws -> NoteIndex {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try d.decode(NoteIndex.self, from: Data(contentsOf: url))
    }

    @Test("a legacy index is moved to system/cache verbatim, and the legacy file is removed")
    func movesLegacyIndex() throws {
        let root = try tmpProject()
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = try fixture("index.json")
        try writeLegacy(legacy, in: root)

        NotesIndexMigration.run(in: root)

        let layout = ProjectLayout(root: root)
        #expect(try Data(contentsOf: layout.notesIndex) == legacy)
        #expect(!exists(layout.legacyNotesIndex))
        let index = try decodeIndex(layout.notesIndex)
        #expect(index.notes.map(\.id) == ["meeting-2026-08-14-standup"])
    }

    @Test("when both files exist, the legacy entries the new index lacks are added and nothing is dropped")
    func unionsWhenBothExist() throws {
        let root = try tmpProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try writeLegacy(try fixture("index-other.json"), in: root)
        let layout = ProjectLayout(root: root)
        try FileManager.default.createDirectory(at: layout.cacheDir, withIntermediateDirectories: true)
        try fixture("index.json").write(to: layout.notesIndex)

        NotesIndexMigration.run(in: root)

        let ids = try decodeIndex(layout.notesIndex).notes.map(\.id).sorted()
        #expect(ids == ["email-2026-08-15-invoice", "meeting-2026-08-14-standup"])
        #expect(!exists(layout.legacyNotesIndex))
    }

    @Test("a second run is a no-op (idempotent)")
    func idempotent() throws {
        let root = try tmpProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try writeLegacy(try fixture("index.json"), in: root)
        NotesIndexMigration.run(in: root)
        let layout = ProjectLayout(root: root)
        let once = try Data(contentsOf: layout.notesIndex)

        NotesIndexMigration.run(in: root)

        #expect(try Data(contentsOf: layout.notesIndex) == once)
        #expect(!exists(layout.legacyNotesIndex))
    }

    @Test("an undecodable legacy index is left exactly where it is and no new file is written")
    func undecodableLeftAlone() throws {
        let root = try tmpProject()
        defer { try? FileManager.default.removeItem(at: root) }
        let junk = Data("{ not an index".utf8)
        try writeLegacy(junk, in: root)

        NotesIndexMigration.run(in: root)

        let layout = ProjectLayout(root: root)
        #expect(try Data(contentsOf: layout.legacyNotesIndex) == junk)
        #expect(!exists(layout.notesIndex))
    }

    @Test("N-1: with only the legacy file present, NoteService still reads its notes")
    func legacyOnlyIsReadByNoteService() async throws {
        let root = try tmpProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try writeLegacy(try fixture("index.json"), in: root)

        let notes = try await NoteService(repoRoot: root).queryNotes()
        #expect(notes.map(\.id) == ["meeting-2026-08-14-standup"])
    }

    @Test("a rebuild writes the new index and retires the legacy copy")
    func rebuildRetiresLegacy() async throws {
        let root = try tmpProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try writeLegacy(try fixture("index.json"), in: root)

        _ = try await NoteService(repoRoot: root).rebuildIndex()

        let layout = ProjectLayout(root: root)
        #expect(exists(layout.notesIndex))
        #expect(!exists(layout.legacyNotesIndex))
    }
}

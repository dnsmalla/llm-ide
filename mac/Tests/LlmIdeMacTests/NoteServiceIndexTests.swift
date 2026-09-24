import Foundation
import Testing
@testable import LlmIdeMacLib

@Suite("NoteService index.json")
struct NoteServiceIndexTests {

    private func tmpRoot() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("note-index-\(UUID().uuidString)", isDirectory: true)
    }

    private func metadata(_ n: Int) -> NoteMetadata {
        NoteMetadata(
            id: "", type: .meeting, source: "test", title: "Note \(n)",
            date: "2026-08-14T10:00:00Z", path: "", rawFile: "meetings/2026/08/n\(n).md",
            sourceHash: nil, generatedAt: "", tags: [], participants: nil, fileSize: 0)
    }

    /// Concurrent writers (the post-Stop summarizer + connector ingest) each
    /// did load → append → save unserialized, so later saves dropped entries.
    @Test("concurrent saves from separate services keep every entry")
    func concurrentSavesKeepAllEntries() async throws {
        let root = tmpRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let count = 40

        try await withThrowingTaskGroup(of: Void.self) { group in
            for n in 0..<count {
                group.addTask {
                    // A fresh service per writer, like each note writer makes.
                    let service = NoteService(repoRoot: root)
                    _ = try await service.saveNote(
                        type: .meeting, filename: "note-\(n).md",
                        content: Data("# \(n)".utf8), metadata: metadata(n))
                }
            }
            try await group.waitForAll()
        }

        let index = try await NoteService(repoRoot: root).loadIndex()
        #expect(index.notes.count == count)
    }

    /// A corrupt index used to read as "new index" and be overwritten with a
    /// single entry. It must be moved aside instead.
    @Test("an undecodable index is moved aside before a save replaces it")
    func corruptIndexIsQuarantined() async throws {
        let root = tmpRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let service = NoteService(repoRoot: root)
        try FileManager.default.createDirectory(at: service.notesRoot, withIntermediateDirectories: true)
        let garbage = Data("{ not json".utf8)
        try garbage.write(to: service.indexPath)

        _ = try await service.saveNote(
            type: .meeting, filename: "one.md", content: Data("# one".utf8), metadata: metadata(1))

        let names = try FileManager.default.contentsOfDirectory(atPath: service.notesRoot.path)
        let quarantined = names.filter { $0.hasPrefix("index.json.corrupt-") }
        #expect(quarantined.count == 1)
        if let name = quarantined.first {
            let kept = try Data(contentsOf: service.notesRoot.appendingPathComponent(name))
            #expect(kept == garbage, "the damaged bytes are preserved, not rewritten")
        }
        #expect(try await service.loadIndex().notes.count == 1)
    }

    @Test("a missing index is a new index, with nothing moved aside")
    func missingIndexIsNew() async throws {
        let root = tmpRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let service = NoteService(repoRoot: root)

        _ = try await service.saveNote(
            type: .meeting, filename: "one.md", content: Data("# one".utf8), metadata: metadata(1))

        let names = try FileManager.default.contentsOfDirectory(atPath: service.notesRoot.path)
        #expect(!names.contains { $0.contains(".corrupt-") })
        #expect(try await service.loadIndex().notes.count == 1)
    }

    /// A damaged index is rebuilt from the note files, so notes saved before
    /// the damage stay listed — and the note being saved is not listed twice.
    @Test("a corrupt index keeps existing notes and does not duplicate the new one")
    func corruptIndexRebuildsFromDisk() async throws {
        let root = tmpRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let service = NoteService(repoRoot: root)
        _ = try await service.saveNote(
            type: .meeting, filename: "old.md", content: Data("# old".utf8), metadata: metadata(1))
        try Data("{ not json".utf8).write(to: service.indexPath)

        #expect(try await service.loadIndex().notes.count == 1, "a read sees the rebuilt index, not an empty one")

        _ = try await service.saveNote(
            type: .meeting, filename: "new.md", content: Data("# new".utf8), metadata: metadata(2))
        let notes = try await service.loadIndex().notes
        #expect(notes.count == 2)
        for n in notes {
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent(n.path).path),
                    "paths are repoRoot-relative: \(n.path)")
        }
    }
}

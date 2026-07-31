import XCTest
@testable import LlmIdeMacLib

/// `NotesToLlmDocMigration` — the one-time, idempotent rename of the legacy
/// `notes/` folder to `llm-doc/`. (`NotesToLlmDocMigration.run` is `@MainActor`.)
@MainActor
final class NotesToLlmDocMigrationTests: XCTestCase {

    func testRenamesNotesToLlmDocWhenLlmDocAbsent() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mig-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: notes.appendingPathComponent("a.md"))

        NotesToLlmDocMigration.run(in: root)

        let llmDoc = root.appendingPathComponent("llm-doc", isDirectory: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: llmDoc.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: notes.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: llmDoc.appendingPathComponent("a.md").path))
    }

    func testIdempotentAndSkipsWhenLlmDocAlreadyExists() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mig2-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        let llmDoc = root.appendingPathComponent("llm-doc", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: llmDoc, withIntermediateDirectories: true)
        try Data("new".utf8).write(to: llmDoc.appendingPathComponent("b.md"))

        // Must NOT clobber the existing llm-doc/, and a second run is a no-op.
        NotesToLlmDocMigration.run(in: root)
        NotesToLlmDocMigration.run(in: root)

        XCTAssertTrue(FileManager.default.fileExists(atPath: notes.path)) // left as-is
        XCTAssertTrue(FileManager.default.fileExists(atPath: llmDoc.appendingPathComponent("b.md").path))
    }

    func testNoOpWhenNeitherFolderExists() {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mig3-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        NotesToLlmDocMigration.run(in: root) // must not throw / crash
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("llm-doc").path))
    }
}

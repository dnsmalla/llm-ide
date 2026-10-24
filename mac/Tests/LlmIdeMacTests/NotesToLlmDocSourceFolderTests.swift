import XCTest
@testable import LlmIdeMacLib

@MainActor
final class NotesToLlmDocSourceFolderTests: XCTestCase {
    private func makeRoot() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("n2l-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func testProjectSourceNotesFolderIsNotRenamed() throws {
        let project = try makeRoot()
        defer { try? FileManager.default.removeItem(at: project) }
        let layout = ProjectLayout(root: project)
        try FileManager.default.createDirectory(
            at: layout.projectJSON.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: layout.projectJSON.path, contents: Data("{}".utf8))
        let source = project.appendingPathComponent("source", isDirectory: true)
        let notes = source.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)

        NotesToLlmDocMigration.runForNotesFolder(source)

        XCTAssertTrue(FileManager.default.fileExists(atPath: notes.path))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: source.appendingPathComponent("llm-doc").path))
    }

    func testLegacyNotesFolderStillMigrates() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("notes"), withIntermediateDirectories: true)

        NotesToLlmDocMigration.runForNotesFolder(root)

        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("llm-doc").path))
    }

    func testSourceFolderOutsideProjectStillMigrates() throws {
        let parent = try makeRoot()
        defer { try? FileManager.default.removeItem(at: parent) }
        let source = parent.appendingPathComponent("source", isDirectory: true)
        try FileManager.default.createDirectory(
            at: source.appendingPathComponent("notes"), withIntermediateDirectories: true)

        NotesToLlmDocMigration.runForNotesFolder(source)

        XCTAssertTrue(FileManager.default.fileExists(atPath: source.appendingPathComponent("llm-doc").path))
    }
}

import XCTest
@testable import LlmIdeMacLib

final class SourceConnectorEngineTests: XCTestCase {
    func testNoteWriterWritesAndReportsHashes() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sc-note-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let writer = SourceConnectorNoteWriter(repoRoot: tmp, noteType: NoteType("slack"))

        let classification = SourceConnectorClassification(
            category: "work", noteWorthy: true, summary: "ship it",
            todos: [SourceConnectorClassification.Todo(title: "t", detail: "d", due: nil, priority: "med")])
        _ = try await writer.writeNote(
            headers: ["Channel": "#team", "User": "alice", "Date": "2026-07-31T09:00:00Z"],
            title: "#team — alice", date: AppDateFormatter.parseISO("2026-07-31T09:00:00Z")!,
            classification: classification, originalBody: "ship it",
            sourceHash: "abc123", rawFile: "SlackInbox/2026/07/x.txt")

        let hashes = try await writer.existingSourceHashes()
        XCTAssertTrue(hashes.contains("abc123"))
    }
}

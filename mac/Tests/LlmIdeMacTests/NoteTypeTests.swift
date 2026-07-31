import XCTest
@testable import LlmIdeMacLib

final class NoteTypeTests: XCTestCase {
    func testLegacyConstantsStillEqualTheirRawValues() {
        XCTAssertEqual(NoteType.meeting.rawValue, "meeting")
        XCTAssertEqual(NoteType.email.rawValue, "email")
        XCTAssertEqual(NoteType.document.rawValue, "document")
    }

    func testNewTypeConstructibleFromArbitraryString() {
        let slack = NoteType(rawValue: "slack")
        XCTAssertEqual(slack.rawValue, "slack")
        XCTAssertEqual(NoteType("slack"), slack)
    }

    func testLegacyDirectoryNamesPreserved() {
        XCTAssertEqual(NoteType.meeting.directoryName, "meetings")
        XCTAssertEqual(NoteType.email.directoryName, "emails")
        XCTAssertEqual(NoteType.document.directoryName, "documents")
        XCTAssertEqual(NoteType(rawValue: "slack").directoryName, "slack")
    }

    func testCodableRoundTripsArbitraryType() throws {
        let original = NoteType(rawValue: "slack")
        let encoded = try JSONEncoder().encode(original)
        XCTAssertEqual(String(data: encoded, encoding: .utf8), #""slack""#)
        let decoded = try JSONDecoder().decode(NoteType.self, from: encoded)
        XCTAssertEqual(decoded, original)
    }
}

extension NoteTypeTests {
    func testRebuildIndexDiscoversAllTypeDirectories() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("notetype-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let svc = NoteService(repoRoot: tmp)

        // Create a legacy plural dir + a new connector dir under llm-doc/.
        for sub in ["meetings/2026/01", "slack/2026/01"] {
            let dir = svc.notesRoot.appendingPathComponent(sub, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data("x".utf8).write(to: dir.appendingPathComponent("a.md"))
        }

        let index = try await svc.rebuildIndex()
        let types = Set(index.notes.map { $0.type.rawValue })
        XCTAssertEqual(types, Set(["meeting", "slack"]))
    }

    func testGetDirForTypeUsesDirectoryName() {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("notetype-dir-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let svc = NoteService(repoRoot: tmp)
        XCTAssertEqual(svc.getDirForType(.meeting).lastPathComponent, "meetings")
        XCTAssertEqual(svc.getDirForType(NoteType("slack")).lastPathComponent, "slack")
    }
}

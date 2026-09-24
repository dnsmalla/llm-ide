import XCTest
@testable import LlmIdeMacLib

/// Tests the meeting-writing half of `ProjectExporter` (`writeMeetings`).
///
/// Meetings must land under `source/meetings/YYYY/MM/`: `SourceFolderMigration`
/// moves any top-level `source/<year>/` into `source/meetings/<year>/` every
/// launch, so an export to `source/YYYY/MM/` relocated itself and left the
/// `_index.json` paths stale.
@MainActor
final class ProjectExporterMeetingsTests: XCTestCase {

    private let fm = FileManager.default

    private func meeting(id: String, title: String, date: String) throws -> ProjectExportBundle.Meeting {
        let json = """
        {"id":"\(id)","title":"\(title)","date":"\(date)","durationSec":60,
         "language":"en","participants":["Aki"],"transcript":"hello","entities":[]}
        """
        return try JSONDecoder().decode(ProjectExportBundle.Meeting.self, from: Data(json.utf8))
    }

    func testMeetingsExportIntoMeetingsSubfolderAndIndexMatches() throws {
        let root = fm.temporaryDirectory.appendingPathComponent("exp-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }

        let m = try meeting(id: "meeting-0000-abcdef12", title: "Standup", date: "2026-08-14T10:00:00Z")
        try ProjectExporter().writeMeetings([m], projectId: "p1", folderURL: root)

        let source = root.appendingPathComponent("source", isDirectory: true)
        XCTAssertFalse(fm.fileExists(atPath: source.appendingPathComponent("2026").path),
                       "no top-level year folder for the launch migration to move")

        let indexData = try Data(contentsOf: source.appendingPathComponent("_index.json"))
        let index = try XCTUnwrap(JSONSerialization.jsonObject(with: indexData) as? [String: Any])
        let entries = try XCTUnwrap(index["meetings"] as? [[String: String]])
        let path = try XCTUnwrap(entries.first?["path"])
        XCTAssertTrue(path.hasPrefix("source/meetings/2026/08/"), path)
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent(path).path),
                      "the index path points at the written file")

        // The launch migration leaves the export where the index says it is.
        SourceFolderMigration.run(in: source, connectors: [])
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent(path).path))
    }
}

import XCTest
@testable import LlmIdeMacLib

/// "Remove from List" is a tombstone: the row stays (hidden), so the folder
/// indexer does not re-add the meeting on its next scan. Deleting the row was
/// the old behaviour, and `FolderIndexer.fullScan` re-upserts every `.md`
/// without a row — the removed meeting came back minutes later.
final class MeetingIndexHiddenTests: XCTestCase {
    var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("meeting-index-hidden-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: root) }

    private func writeMeeting(_ name: String, id: String) throws -> URL {
        let dir = root.appendingPathComponent("meetings/2026/09", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        let fm = MeetingFrontmatter(id: id, title: "T \(id)", startedAt: Date(timeIntervalSince1970: 1_790_000_000),
                                    platform: "meet", language: "en")
        let yaml = try FrontmatterCoder.encode(fm)
        try "---\n\(yaml)---\n\n## Transcript\n\nhello\n".write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func testHiddenMeetingStaysHiddenAcrossAFullScan() throws {
        _ = try writeMeeting("a.md", id: "m-a")
        _ = try writeMeeting("b.md", id: "m-b")
        let index = try MeetingIndex(url: root.appendingPathComponent("index.sqlite"))
        let indexer = FolderIndexer(root: root, index: index)
        try indexer.fullScan()
        XCTAssertEqual(try index.list().map(\.id).sorted(), ["m-a", "m-b"])

        try index.hide(id: "m-a")
        XCTAssertEqual(try index.list().map(\.id), ["m-b"], "hidden row is out of the list")
        XCTAssertEqual(try index.listAll().count, 2, "but still indexed")

        // The scan that used to resurrect it.
        try indexer.fullScan()
        XCTAssertEqual(try index.list().map(\.id), ["m-b"])

        // Even when the file changes on disk, the tombstone survives the re-index.
        let url = root.appendingPathComponent("meetings/2026/09/a.md")
        try (try String(contentsOf: url, encoding: .utf8) + "\nmore\n").write(to: url, atomically: true, encoding: .utf8)
        try indexer.fullScan()
        XCTAssertEqual(try index.list().map(\.id), ["m-b"])
        XCTAssertEqual(try index.get(id: "m-a")?.hidden, true)

        // Deleting the file reaps the tombstone like any row.
        try FileManager.default.removeItem(at: url)
        try indexer.fullScan()
        XCTAssertEqual(try index.listAll().map(\.id), ["m-b"])
    }
}

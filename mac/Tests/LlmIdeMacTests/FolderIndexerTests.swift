import Testing
@testable import LlmIdeMac
import Foundation

final class FolderIndexerTests {

    let tempRoot: URL
    let indexURL: URL

    init() throws {
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("fi-\(UUID().uuidString)")
        indexURL = tempRoot.appendingPathComponent("system/index.sqlite")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    @Test func fullScanFindsExistingMarkdownFiles() throws {
        try writeMeeting(named: "2026-05-08-q1-planning.md", id: "01HAAA", title: "Q1 Planning")
        try writeMeeting(named: "2026-05-07-standup.md", id: "01HBBB", title: "Standup")

        let idx = try MeetingIndex(url: indexURL)
        let indexer = FolderIndexer(root: tempRoot, index: idx)
        try indexer.fullScan()

        let rows = try idx.list()
        #expect(Set(rows.map(\.id)) == Set(["01HAAA", "01HBBB"]))
    }

    @Test func fullScanSkipsPartialFiles() throws {
        try writeMeeting(named: "2026-05-08-x.partial.md", id: "01HPPP", title: "")
        let idx = try MeetingIndex(url: indexURL)
        let indexer = FolderIndexer(root: tempRoot, index: idx)
        try indexer.fullScan()
        #expect(try idx.count() == 0)
    }

    @Test func fullScanDetectsDeletion() throws {
        let path = try writeMeeting(named: "2026-05-08-x.md", id: "01HAAA", title: "X")
        let idx = try MeetingIndex(url: indexURL)
        let indexer = FolderIndexer(root: tempRoot, index: idx)
        try indexer.fullScan()
        #expect(try idx.count() == 1)

        try FileManager.default.removeItem(at: path)
        try indexer.fullScan()
        #expect(try idx.count() == 0)
    }

    @discardableResult
    private func writeMeeting(named filename: String, id: String, title: String) throws -> URL {
        let monthDir = tempRoot.appendingPathComponent("2026/05", isDirectory: true)
        try FileManager.default.createDirectory(at: monthDir, withIntermediateDirectories: true)
        let url = monthDir.appendingPathComponent(filename)
        let body = """
        ---
        id: \(id)
        title: "\(title)"
        started_at: 2026-05-08T14:00:00Z
        platform: meet
        language: en
        tldr: []
        participants: []
        ---

        ## Transcript

        """
        try body.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}

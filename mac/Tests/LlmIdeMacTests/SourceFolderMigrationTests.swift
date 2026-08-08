// mac/Tests/LlmIdeMacTests/SourceFolderMigrationTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceFolderMigrationTests: XCTestCase {
    private func makeRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("sfm-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
    private func write(_ root: URL, _ rel: String, _ body: String = "x") throws {
        let url = root.appendingPathComponent(rel)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try Data(body.utf8).write(to: url)
    }
    private func slackManifest() -> SourceConnectorManifest {
        SourceConnectorManifest(id: "slack", displayName: "Slack", icon: "message",
            emptyText: "—", platforms: ["slack"], mode: .fetch,
            inboxFolder: "SlackArchive", noteType: "slack",
            endpoints: .init(test: "/t", fetch: "/f", seen: "/s", classify: "/c"),
            adapter: "SlackAdapter", configFields: [], rawHeaders: [:], noiseFilter: nil)
    }

    func testMovesEmailFlatMeetingsAndConnectorRaw() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        try write(root, "EmailInbox/2026/05/a.txt")
        try write(root, "2026/05/m.md")              // flat meeting raw
        try write(root, "SlackArchive/2026/06/s.txt") // connector raw

        SourceFolderMigration.run(in: root, connectors: [slackManifest()])

        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("emails/2026/05/a.txt").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("meetings/2026/05/m.md").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("slack/2026/06/s.txt").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("EmailInbox").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("SlackArchive").path))
    }

    func testIdempotentAndDoesNotClobber() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        try write(root, "emails/2026/05/keep.txt", "keep")   // already migrated
        try write(root, "EmailInbox/2026/05/keep.txt", "new") // would conflict

        SourceFolderMigration.run(in: root, connectors: [slackManifest()])
        SourceFolderMigration.run(in: root, connectors: [slackManifest()])

        // Existing dest preserved (no clobber).
        let kept = try String(contentsOf: root.appendingPathComponent("emails/2026/05/keep.txt"), encoding: .utf8)
        XCTAssertEqual(kept, "keep")

        // Legacy conflict survives: the skipped entry is left in place rather
        // than deleted, and the legacy folder stays because it was non-empty
        // after the skip.
        let legacy = try String(contentsOf: root.appendingPathComponent("EmailInbox/2026/05/keep.txt"), encoding: .utf8)
        XCTAssertEqual(legacy, "new")
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("EmailInbox").path))
    }

    func testNoOpOnCleanTree() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        SourceFolderMigration.run(in: root, connectors: [slackManifest()]) // must not throw
    }

    func testDoesNotDeleteNonDirectoryYearEntry() throws {
        // A regular file named `2026` at the source root matches the 4-digit
        // flat-meeting detector. It must be left in place, not deleted: the
        // migration is move-only and `mergeMove` is a no-op for non-directories.
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        try write(root, "2026", "not-a-folder")          // file, not a directory
        try write(root, "2027/05/m.md")                  // a real year dir, for realism

        SourceFolderMigration.run(in: root, connectors: [slackManifest()])

        // The `2026` file survives (was not deleted).
        let yearFile = root.appendingPathComponent("2026")
        XCTAssertTrue(FileManager.default.fileExists(atPath: yearFile.path))
        let body = try String(contentsOf: yearFile, encoding: .utf8)
        XCTAssertEqual(body, "not-a-folder")

        // The real year dir still migrated normally.
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("meetings/2027/05/m.md").path))
    }
}

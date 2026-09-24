// mac/Tests/LlmIdeMacTests/MeetingFileStoreRawDirTests.swift
import XCTest
@testable import LlmIdeMacLib

final class MeetingFileStoreRawDirTests: XCTestCase {
    func testCreatePartialWritesUnderMeetingsMonthFolder() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mfs-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = MeetingFileStore(root: root)
        let date = Date()
        let cal = Calendar(identifier: .iso8601)
        let c = cal.dateComponents([.year, .month], from: date)

        let handle = try store.createPartial(id: "abc12345", startedAt: date,
                                             platform: "google-meet", language: "")
        try handle.close()

        let expected = root.appendingPathComponent("meetings", isDirectory: true)
            .appendingPathComponent(String(format: "%04d", c.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", c.month ?? 0), isDirectory: true)
        XCTAssertEqual(handle.url.deletingLastPathComponent().path, expected.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: handle.url.path))
    }

    /// Two captures started within the same minute used to share one file —
    /// the partial name was unique per MINUTE and the atomic write truncated
    /// the first session's transcript.
    func testTwoPartialsInTheSameMinuteGetDistinctFiles() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mfs-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = MeetingFileStore(root: root)
        let date = Date()

        let first = try store.createPartial(id: "aaaa1111-first", startedAt: date, platform: "teams", language: "")
        try first.fileHandle.write(contentsOf: Data("first session captions\n".utf8))
        try first.close()
        let second = try store.createPartial(id: "bbbb2222-second", startedAt: date, platform: "teams", language: "")
        try second.close()

        XCTAssertNotEqual(first.url, second.url)
        XCTAssertTrue(first.url.lastPathComponent.contains("aaaa1111"))
        XCTAssertTrue(try String(contentsOf: first.url, encoding: .utf8).contains("first session captions"),
                      "the first transcript survives the second start")
        // Same id twice (should not happen) still never truncates the existing file.
        let again = try store.createPartial(id: "aaaa1111-first", startedAt: date, platform: "teams", language: "")
        try again.close()
        XCTAssertNotEqual(again.url, first.url)
    }

    /// Slack ids are `slack-<channel>-<ts>`: the old `id.prefix(8)` suffix was
    /// always `slack-C0`, so two same-title chunks finalized to ONE filename
    /// and the second replaced the first.
    func testFinalFilenamesStayDistinctForIdsSharingAPrefix() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mfs-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = MeetingFileStore(root: root)
        let date = Date(timeIntervalSince1970: 1_700_000_000)

        var urls: [URL] = []
        for id in ["slack-C0123-1700000000.000100", "slack-C0123-1700000000.000200"] {
            let h = try store.createPartial(id: id, startedAt: date, platform: "slack", language: "")
            try h.appendCaption(timestamp: date, speaker: "u", text: id)
            urls.append(try store.finalize(handle: h, title: "Slack #C0123", endedAt: date, participants: []))
        }

        XCTAssertNotEqual(urls[0], urls[1])
        XCTAssertTrue(FileManager.default.fileExists(atPath: urls[0].path), "first chunk not overwritten")
        XCTAssertFalse(urls[0].lastPathComponent.contains("slack-C0"))
    }

    func testIdDisambiguatorKeepsUUIDPrefixAndHashesOtherIdsStably() {
        let uuid = "1A2B3C4D-0000-4000-8000-000000000000"
        XCTAssertEqual(MeetingFileStore.idDisambiguator(uuid), "1A2B3C4D", "UUID filenames unchanged")
        let a = MeetingFileStore.idDisambiguator("m-lx1abc-9f8e7d")
        XCTAssertEqual(a.count, 8)
        XCTAssertEqual(a, MeetingFileStore.idDisambiguator("m-lx1abc-9f8e7d"), "stable across calls")
        XCTAssertNotEqual(a, MeetingFileStore.idDisambiguator("m-lx1abc-000000"))
    }

    /// A Stop with no captions discards the partial (and CaptionOrchestrator
    /// drops its recovery record) so the next launch has nothing to recover.
    func testDiscardPartialClosesAndDeletesTheFile() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mfs-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = MeetingFileStore(root: root)
        let handle = try store.createPartial(id: "empty-session", startedAt: Date(),
                                             platform: "teams", language: "")
        let recovery = PartialRecovery(notesFolder: root)
        try recovery.record(id: handle.id, path: handle.url, pid: 999_999, startedAt: Date())

        store.discardPartial(handle: handle)
        try recovery.cleanup(id: handle.id)

        XCTAssertFalse(FileManager.default.fileExists(atPath: handle.url.path))
        XCTAssertTrue(try recovery.scanOrphans().isEmpty)
        XCTAssertNoThrow(try handle.close(), "close stays idempotent after a discard")
    }
}

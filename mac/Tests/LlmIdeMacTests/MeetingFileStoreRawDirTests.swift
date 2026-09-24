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
}

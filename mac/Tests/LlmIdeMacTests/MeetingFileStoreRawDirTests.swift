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
}

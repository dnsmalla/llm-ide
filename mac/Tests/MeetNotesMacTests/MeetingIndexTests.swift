import Testing
@testable import MeetNotesMac
import Foundation

final class MeetingIndexTests {

    let tempDB: URL

    init() throws {
        tempDB = FileManager.default.temporaryDirectory
            .appendingPathComponent("idx-\(UUID().uuidString).sqlite")
    }

    deinit {
        try? FileManager.default.removeItem(at: tempDB)
    }

    @Test func upsertAndList() throws {
        let idx = try MeetingIndex(url: tempDB)
        try idx.upsert(MeetingIndex.Row(
            id: "a", path: "2026/05/x.md", title: "A",
            startedAt: 1000, endedAt: 2000, durationSec: 1000,
            gist: "g", tldrJSON: "[\"x\"]",
            actionsCount: 1, decisionsCount: 0, blockersCount: 0,
            fileMtime: 5, fileSize: 100, indexedAt: 99
        ))
        try idx.upsert(MeetingIndex.Row(
            id: "b", path: "2026/05/y.md", title: "B",
            startedAt: 2000, endedAt: 3000, durationSec: 1000,
            gist: nil, tldrJSON: nil,
            actionsCount: 0, decisionsCount: 0, blockersCount: 0,
            fileMtime: 6, fileSize: 50, indexedAt: 99
        ))
        let rows = try idx.list()
        #expect(rows.map(\.id) == ["b", "a"])
    }

    @Test func deleteRemovesRow() throws {
        let idx = try MeetingIndex(url: tempDB)
        try idx.upsert(.init(id: "a", path: "x", title: "A",
                             startedAt: 1, endedAt: 2, durationSec: 1,
                             gist: nil, tldrJSON: nil,
                             actionsCount: 0, decisionsCount: 0, blockersCount: 0,
                             fileMtime: 1, fileSize: 1, indexedAt: 1))
        try idx.delete(id: "a")
        #expect(try idx.list().count == 0)
    }

    @Test func count() throws {
        let idx = try MeetingIndex(url: tempDB)
        #expect(try idx.count() == 0)
        try idx.upsert(.init(id: "a", path: "x", title: "A",
                             startedAt: 1, endedAt: 2, durationSec: 1,
                             gist: nil, tldrJSON: nil,
                             actionsCount: 0, decisionsCount: 0, blockersCount: 0,
                             fileMtime: 1, fileSize: 1, indexedAt: 1))
        #expect(try idx.count() == 1)
    }
}

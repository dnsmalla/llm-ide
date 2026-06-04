import Testing
@testable import LlmIdeMac
import Foundation

@MainActor
final class LibraryViewModelTests {

    let tempRoot: URL
    let idx: MeetingIndex

    init() throws {
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("lib-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        idx = try MeetingIndex(url: tempRoot.appendingPathComponent("idx.sqlite"))
    }

    deinit {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    @Test func listSortedNewestFirst() throws {
        try idx.upsert(.init(id: "a", path: "x", title: "A",
            startedAt: 1000, endedAt: nil, durationSec: nil, gist: nil, tldrJSON: nil,
            actionsCount: 0, decisionsCount: 0, blockersCount: 0,
            fileMtime: 1, fileSize: 1, indexedAt: 1))
        try idx.upsert(.init(id: "b", path: "x", title: "B",
            startedAt: 2000, endedAt: nil, durationSec: nil, gist: nil, tldrJSON: nil,
            actionsCount: 0, decisionsCount: 0, blockersCount: 0,
            fileMtime: 1, fileSize: 1, indexedAt: 1))
        let vm = LibraryViewModel(index: idx)
        try vm.refresh()
        #expect(vm.visibleRows.map(\.id) == ["b", "a"])
    }

    @Test func filterMatchesTitleSubstring() throws {
        try idx.upsert(.init(id: "a", path: "x", title: "Standup Tuesday",
            startedAt: 1000, endedAt: nil, durationSec: nil, gist: nil, tldrJSON: nil,
            actionsCount: 0, decisionsCount: 0, blockersCount: 0,
            fileMtime: 1, fileSize: 1, indexedAt: 1))
        try idx.upsert(.init(id: "b", path: "x", title: "Q1 Planning",
            startedAt: 2000, endedAt: nil, durationSec: nil, gist: nil, tldrJSON: nil,
            actionsCount: 0, decisionsCount: 0, blockersCount: 0,
            fileMtime: 1, fileSize: 1, indexedAt: 1))
        let vm = LibraryViewModel(index: idx)
        try vm.refresh()
        vm.filter = "stand"
        #expect(vm.visibleRows.map(\.id) == ["a"])
    }
}

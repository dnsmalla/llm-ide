import XCTest
@testable import LlmIdeMac

/// ChatSessionStore persistence: list/filter, save/load/delete, legacy migration, scoped clear.
/// Blocked from CI until `Package.swift` splits app sources into a library target — see
/// `README-truncated-tests.md`.
final class ChatSessionStoreTests: XCTestCase {
    var tmp: URL!

    override func setUp() {
        tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-store-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
    }

    override func tearDown() {
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    func testListFiltersByScopeAndSorts() {
        var a = ChatSession(scope: .explorer, title: "A")
        a.lastUsedAt = Date().addingTimeInterval(-100)
        var b = ChatSession(scope: .explorer, title: "B")
        b.lastUsedAt = Date()
        let other = ChatSession(scope: .visual, title: "V")
        ChatSessionStore.save(a)
        ChatSessionStore.save(b)
        ChatSessionStore.save(other)
        let list = ChatSessionStore.list(for: .explorer)
        XCTAssertEqual(list.map(\.title), ["B", "A"])
    }

    func testSaveLoadDeleteRoundTrip() {
        let s = ChatSession(scope: .conflicts, title: "X")
        ChatSessionStore.save(s)
        XCTAssertEqual(ChatSessionStore.load(id: s.id)?.title, "X")
        ChatSessionStore.delete(id: s.id)
        XCTAssertNil(ChatSessionStore.load(id: s.id))
    }

    func testMigrateScopeFileOnce() throws {
        let legacyDir = tmp.appendingPathComponent("sessions", isDirectory: true)
        try FileManager.default.createDirectory(at: legacyDir, withIntermediateDirectories: true)
        let legacy = ChatSession(scope: .explorer, title: "Old", history: [])
        let url = legacyDir.appendingPathComponent("explorer.json")
        let data = try AppJSON.encoder.encode(legacy)
        try data.write(to: url)
        let migrated = ChatSessionStore.migrateScopeFileIfNeeded(for: .explorer)
        XCTAssertEqual(migrated?.title, "Old")
        XCTAssertEqual(migrated?.scope, .explorer)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertNil(ChatSessionStore.migrateScopeFileIfNeeded(for: .explorer))
        XCTAssertEqual(ChatSessionStore.list(for: .explorer).count, 1)
    }

    func testClearForScopeLeavesOthers() {
        ChatSessionStore.save(ChatSession(scope: .explorer, title: "E"))
        ChatSessionStore.save(ChatSession(scope: .visual, title: "V"))
        ChatSessionStore.clear(for: .explorer)
        XCTAssertTrue(ChatSessionStore.list(for: .explorer).isEmpty)
        XCTAssertEqual(ChatSessionStore.list(for: .visual).count, 1)
    }
}

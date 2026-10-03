import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ProcessedActionsRegistryTests: XCTestCase {
    private func makeRegistry() -> ProcessedActionsRegistry {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("registry-\(UUID().uuidString).json")
        let registry = ProcessedActionsRegistry(storeURL: url)
        registry.bootstrap()
        return registry
    }

    private func action(_ id: String) -> NoteAction {
        NoteAction(id: id, text: "text \(id)", meetingId: "m", meetingTitle: "t")
    }

    func testPendingEntriesAreScopedToRepoKey() {
        let registry = makeRegistry()
        registry.register(action: action("a"), issueIid: 7, repoKey: "gitlab/A")
        registry.register(action: action("b"), issueIid: 8, repoKey: "gitlab/B")
        XCTAssertEqual(registry.pendingEntries(repoKey: "gitlab/B").map(\.actionId), ["b"])
        XCTAssertTrue(registry.isKnown(id: "a", repoKey: "gitlab/A"))
        XCTAssertFalse(registry.isKnown(id: "a", repoKey: "gitlab/B"))
    }

    func testLegacyNilKeyEntryCountsAsKnownButIsNotPendingForARepo() {
        let registry = makeRegistry()
        registry.register(action: action("old"), issueIid: 1)
        // Known everywhere: never re-create an issue for it…
        XCTAssertTrue(registry.isKnown(id: "old", repoKey: "gitlab/B"))
        // …but its issueIid belongs to an unknown repo, so never implement it
        // against whichever repo is active now.
        XCTAssertTrue(registry.pendingEntries(repoKey: "gitlab/B").isEmpty)
        XCTAssertEqual(registry.pendingEntries().map(\.actionId), ["old"])
    }

    func testSameActionInTwoReposKeepsBothEntries() {
        let registry = makeRegistry()
        registry.register(action: action("shared"), issueIid: 7, repoKey: "gitlab/A")
        registry.register(action: action("shared"), issueIid: 9, repoKey: "gitlab/B")
        XCTAssertEqual(registry.pendingEntries(repoKey: "gitlab/A").first?.issueIid, 7)
        XCTAssertEqual(registry.pendingEntries(repoKey: "gitlab/B").first?.issueIid, 9)
        registry.markDone(id: "shared", repoKey: "gitlab/A")
        XCTAssertTrue(registry.pendingEntries(repoKey: "gitlab/A").isEmpty)
        XCTAssertEqual(registry.pendingEntries(repoKey: "gitlab/B").count, 1)
    }

    func testPendingEntriesSortedByRegisteredAt() throws {
        let registry = makeRegistry()
        registry.register(action: action("first"), issueIid: 1, repoKey: "k")
        Thread.sleep(forTimeInterval: 0.01)
        registry.register(action: action("second"), issueIid: 2, repoKey: "k")
        XCTAssertEqual(registry.pendingEntries(repoKey: "k").map(\.actionId), ["first", "second"])
    }

    func testMarkPendingDoesNotBumpRetryCount() {
        let registry = makeRegistry()
        registry.register(action: action("a"), issueIid: 1, repoKey: "k")
        registry.markImplementing(id: "a", repoKey: "k")
        registry.markPending(id: "a", repoKey: "k")
        let entry = registry.pendingEntries(repoKey: "k").first
        XCTAssertEqual(entry?.retryCount, 0)
        XCTAssertEqual(entry?.status, .pending)
    }
}

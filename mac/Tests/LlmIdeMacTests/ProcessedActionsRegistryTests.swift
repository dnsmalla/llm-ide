import Testing
@testable import LlmIdeMac
import Foundation

final class ProcessedActionsRegistryTests {

    var registry: ProcessedActionsRegistry!
    let tempFile: URL

    init() throws {
        tempFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("par-\(UUID().uuidString).json")
        registry = ProcessedActionsRegistry(storeURL: tempFile)
        // The registry defers disk reads to bootstrap() so the
        // app launch doesn't pay the JSON-decode cost. Tests must
        // call it explicitly — without this, load() never runs
        // and the in-memory `entries` dictionary stays empty.
        registry.bootstrap()
    }

    deinit { try? FileManager.default.removeItem(at: tempFile) }

    @Test func newActionIsUnknown() {
        #expect(!registry.isKnown(id: "abc"))
    }

    @Test func registerMakesActionKnown() {
        let action = NoteAction(id: "aaa", text: "Fix bug", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 42)
        #expect(registry.isKnown(id: "aaa"))
    }

    @Test func registeredActionStartsAsPending() {
        let action = NoteAction(id: "bbb", text: "Add tests", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 10)
        let entries = registry.pendingEntries()
        #expect(entries.count == 1)
        #expect(entries[0].status == .pending)
        #expect(entries[0].issueIid == 10)
    }

    @Test func markDoneRemovesFromPending() {
        let action = NoteAction(id: "ccc", text: "Deploy", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 5)
        registry.markDone(id: "ccc")
        #expect(registry.pendingEntries().isEmpty)
    }

    @Test func markFailedIncrementsRetryCount() {
        let action = NoteAction(id: "ddd", text: "Refactor", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 7)
        registry.markFailed(id: "ddd")
        let entries = registry.pendingEntries()
        #expect(entries[0].retryCount == 1)
        #expect(entries[0].status == .failed)
    }

    @Test func failedActionsUnder3RetriesAreRetried() {
        let action = NoteAction(id: "eee", text: "Write docs", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 9)
        registry.markFailed(id: "eee")
        registry.markFailed(id: "eee")
        // 2 retries — still appears in pendingEntries
        #expect(registry.pendingEntries().count == 1)
    }

    @Test func failedActionsAt3RetriesAreExcluded() {
        let action = NoteAction(id: "fff", text: "Exhausted", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 11)
        registry.markFailed(id: "fff")
        registry.markFailed(id: "fff")
        registry.markFailed(id: "fff")
        // 3 retries — no longer retried
        #expect(registry.pendingEntries().isEmpty)
    }

    @Test func persistsAndLoadsAcrossInstances() {
        let action = NoteAction(id: "ggg", text: "Persist me", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 20)
        registry.markDone(id: "ggg")

        let loaded = ProcessedActionsRegistry(storeURL: tempFile)
        loaded.bootstrap()                          // <-- triggers load()
        #expect(loaded.isKnown(id: "ggg"))
        #expect(loaded.pendingEntries().isEmpty)
    }

    @Test func implementingEntriesAreResetToPendingOnInit() {
        let action = NoteAction(id: "hhh", text: "In flight", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 30)
        registry.markImplementing(id: "hhh")
        // Simulate crash-restart: load fresh instance from same file.
        // bootstrap() is what triggers the resetStuckImplementing()
        // sweep — without this call the test only sees the empty
        // in-memory state of the freshly-init'd registry.
        let reloaded = ProcessedActionsRegistry(storeURL: tempFile)
        reloaded.bootstrap()
        let entries = reloaded.pendingEntries()
        #expect(entries.count == 1)
        #expect(entries[0].status == .pending)
    }

    @Test func registerIsIdempotentForKnownAction() {
        let action = NoteAction(id: "iii", text: "Idempotent", meetingId: "M1", meetingTitle: "Sprint")
        registry.register(action: action, issueIid: 1)
        registry.register(action: action, issueIid: 99) // second call must be a no-op
        #expect(registry.pendingEntries().count == 1)
        #expect(registry.pendingEntries()[0].issueIid == 1) // first registration wins
    }

    @Test func markFailedOnUnknownIdIsNoOp() {
        // Should not crash, should not create an entry
        registry.markFailed(id: "unknown-id")
        #expect(registry.pendingEntries().isEmpty)
        #expect(!registry.isKnown(id: "unknown-id"))
    }
}

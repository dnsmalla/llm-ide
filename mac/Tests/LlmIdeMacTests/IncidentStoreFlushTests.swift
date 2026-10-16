import Foundation
import Testing
@testable import LlmIdeMacLib

@Suite("IncidentStore quit flush")
@MainActor
struct IncidentStoreFlushTests {
    private func makeStore() -> (IncidentStore, URL) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("incident-flush-\(UUID().uuidString)")
            .appendingPathComponent("incidents.json")
        // A long debounce, so only the explicit flush can have written.
        return (IncidentStore(fileURL: url, saveDelay: .seconds(60)), url)
    }

    @Test func flushPendingSaveWritesADebouncedChangeImmediately() throws {
        let (store, url) = makeStore()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let now = Date()
        store.upsert(Incident(id: "a", source: .server, category: "server", message: "boom",
                              stack: nil, firstSeen: now, lastSeen: now))
        store.update(id: "a") { $0.status = .proposed }
        #expect(store.saveCount == 0)

        store.flushPendingSave()

        #expect(store.saveCount == 1)
        let reloaded = IncidentStore(fileURL: url)
        #expect(reloaded.incidents.first?.status == .proposed)
    }

    @Test func flushPendingSaveIsANoOpWithNothingPending() {
        let (store, url) = makeStore()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        store.flushPendingSave()
        #expect(store.saveCount == 0)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }
}

import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SessionScopedResetTests: XCTestCase {
    private final class Probe: SessionScoped {
        var resets = 0
        func resetForSignOut() { resets += 1 }
    }

    func testResetAllCallsEveryLiveConformerOnce() {
        let registry = SessionScopedRegistry()
        let first = Probe()
        let second = Probe()
        registry.register(first)
        registry.register(first) // duplicate ignored
        registry.register(second)
        registry.resetAll()
        XCTAssertEqual(first.resets, 1)
        XCTAssertEqual(second.resets, 1)
    }

    func testRegistryHoldsConformersWeakly() {
        let registry = SessionScopedRegistry()
        var probe: Probe? = Probe()
        registry.register(probe!)
        XCTAssertEqual(registry.registeredCount, 1)
        probe = nil
        XCTAssertEqual(registry.registeredCount, 0)
    }

    func testActivityStoreResetClearsCursor() {
        let store = ActivityStore()
        store.resetForSignOut()
        XCTAssertEqual(store.lastId, 0)
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(store.unreadCount, 0)
    }
}

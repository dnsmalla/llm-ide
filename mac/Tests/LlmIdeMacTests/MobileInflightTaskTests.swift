import XCTest
@testable import LlmIdeMacLib

/// Bookkeeping for phone commands' in-flight tasks in `MobileControlManager`.
@MainActor
final class MobileInflightTaskTests: XCTestCase {
    /// Let queued main-actor work (task bodies, their defers, prune hops) run.
    private func drainMainActor() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 50_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    /// Re-registering a commandId cancels the old task; the old task's finish
    /// used to remove the NEW task's entry, orphaning it from phone cancel.
    func testReRegistrationKeepsTheNewTasksEntry() async {
        let manager = MobileControlManager()
        manager.registerMobileInflightTask(commandId: "c1") {
            while !Task.isCancelled { try? await Task.sleep(nanoseconds: 5_000_000) }
        }
        await drainMainActor()
        manager.registerMobileInflightTask(commandId: "c1") {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
        }
        await drainMainActor()
        XCTAssertEqual(manager.mobileInflightCommandIds, ["c1"],
                       "the old task's finish must not drop the new task's entry")
        manager.cancelMobileInflightTask(commandId: "c1")
        XCTAssertTrue(manager.mobileInflightCommandIds.isEmpty)
    }
}

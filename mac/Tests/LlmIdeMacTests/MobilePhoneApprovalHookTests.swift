import XCTest
@testable import LlmIdeMacLib

/// The phone arms install `ChatEngine.hooks.onExternalApproval` — a single
/// slot — before `runExternalTurn`, which throws `.busy` synchronously when a
/// turn is already running. The rejected command's `defer` used to clear the
/// slot unconditionally, silencing the RUNNING turn's questions on the phone.
@MainActor
final class MobilePhoneApprovalHookTests: XCTestCase {
    func testBusyRejectedCommandLeavesRunningTurnsHookInPlace() {
        let manager = MobileControlManager()
        let engine = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())

        manager.beginPhoneApprovals(engine: engine, commandId: "running")
        XCTAssertNotNil(engine.hooks.onExternalApproval)
        engine.busy = true

        // Second phone command hits the busy engine: begin + defer'd end.
        manager.beginPhoneApprovals(engine: engine, commandId: "rejected")
        manager.endPhoneApprovals(engine: engine, commandId: "rejected")
        XCTAssertNotNil(engine.hooks.onExternalApproval,
                        "a busy-rejected command must not clear the running turn's hook")

        engine.busy = false
        manager.endPhoneApprovals(engine: engine, commandId: "running")
        XCTAssertNil(engine.hooks.onExternalApproval)
    }

    func testBusyEngineIsNotHookedByPhone() {
        let manager = MobileControlManager()
        let engine = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
        engine.busy = true // e.g. a Mac-driven turn
        manager.beginPhoneApprovals(engine: engine, commandId: "phone")
        XCTAssertNil(engine.hooks.onExternalApproval)
    }
}

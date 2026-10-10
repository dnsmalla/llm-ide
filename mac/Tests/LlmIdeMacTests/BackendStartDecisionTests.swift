import XCTest
@testable import LlmIdeMacLib

/// A port held by a foreign process (one `killExternalListener` refuses to
/// kill) must not lead to a spawn: node can't bind, exits non-zero and the
/// auto-restart path crash-loops.
final class BackendStartDecisionTests: XCTestCase {
    func testHealthyListenerIsAdopted() {
        XCTAssertEqual(BackendManager.startDecision(healthy: true, stillHeld: true), .adopt)
        XCTAssertEqual(BackendManager.startDecision(healthy: true, stillHeld: false), .adopt)
    }

    func testFreedPortSpawns() {
        XCTAssertEqual(BackendManager.startDecision(healthy: false, stillHeld: false), .spawn)
    }

    func testPortStillHeldAfterKillAttemptRefusesToSpawn() {
        XCTAssertEqual(BackendManager.startDecision(healthy: false, stillHeld: true), .refuseOccupied)
    }

    func testOccupiedMessageTellsUserHowToFreeThePort() {
        let msg = BackendManager.portOccupiedMessage(port: 3456)
        XCTAssertTrue(msg.contains("lsof -ti :3456"))
        XCTAssertTrue(msg.contains("in use"))
    }
}

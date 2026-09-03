import XCTest
@testable import LlmIdeMacLib

@MainActor
private final class SpyBridge: MobileFeatureBridge {
    var handled: [String] = []
    var installs = 0
    var accepts: Bool = true
    func handle(type: String, data: Data?) -> Bool {
        handled.append(type); return accepts
    }
    func installPushObservers() { installs += 1 }
}

@MainActor
final class MobileFeatureBridgeTests: XCTestCase {
    func testManagerRoutesAutoTaskTypesToBridge() {
        let manager = MobileControlManager()
        let spy = SpyBridge()
        manager.autoTaskBridge = spy
        XCTAssertTrue(manager.routeToFeatureBridge(type: "auto_task_list", data: nil))
        XCTAssertEqual(spy.handled, ["auto_task_list"])
    }

    func testLoopTypesGoToLoopBridge() {
        let manager = MobileControlManager()
        let spy = SpyBridge()
        manager.loopBridge = spy
        XCTAssertTrue(manager.routeToFeatureBridge(type: "loop_status_list", data: nil))
        XCTAssertEqual(spy.handled, ["loop_status_list"])
    }

    func testNilBridgeStillReportsHandledSoCallerAcksUnavailable() {
        let manager = MobileControlManager()
        // No bridges installed: routing must still claim the message (true)
        // so the generic unknown-type path never sees a feature type; the
        // manager's replyFeatureUnavailable path is exercised internally.
        XCTAssertTrue(manager.routeToFeatureBridge(type: "auto_task_run", data: nil))
        XCTAssertTrue(manager.routeToFeatureBridge(type: "loop_stop", data: nil))
    }

    func testNonFeatureTypesAreNotClaimed() {
        let manager = MobileControlManager()
        XCTAssertFalse(manager.routeToFeatureBridge(type: "chat_send", data: nil))
    }

    /// Pin the two routing Sets `MobileControlManager` uses to decide which
    /// bridge a `SharedProtocol` message type belongs to. These literals are a
    /// deliberate COPY of `MobileControlManager.autoTaskMessageTypes` /
    /// `.loopMessageTypes`, not a reference to them — the point of this test
    /// is to catch drift between those Sets and the bridges' own
    /// `handle(type:data:)` switches, so it must not read the Sets it is
    /// checking. Adding a new `auto_task_*`/`loop_*` message type to
    /// `SharedProtocol` must update BOTH the owning bridge's `handle` switch
    /// AND the matching Set in `MobileControlManager` AND this test — missing
    /// any one of the three either misroutes the new type or leaves it
    /// silently unpinned here.
    func testRoutingSetsMatchHardcodedExpectedLiterals() {
        let expectedAutoTaskTypes: Set<String> = [
            "auto_task_list",
            "auto_task_toggle",
            "auto_task_run",
            "auto_task_stop",
            "auto_task_history",
            "auto_task_logs_list",
            "auto_task_setup_list",
            "auto_task_config_set",
            "auto_task_template_save",
            "auto_task_template_rename",
            "auto_task_template_delete",
        ]
        let expectedLoopTypes: Set<String> = [
            "loop_status_list",
            "loop_start",
            "loop_start_stage",
            "loop_stop",
            "loop_history",
        ]
        XCTAssertEqual(MobileControlManager.autoTaskMessageTypes, expectedAutoTaskTypes)
        XCTAssertEqual(MobileControlManager.loopMessageTypes, expectedLoopTypes)
    }
}

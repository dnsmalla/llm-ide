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
}

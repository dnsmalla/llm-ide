import XCTest
@testable import LlmIdeMacLib

/// A phone Loop start that waits (snapshot load, queue behind a run) is re-validated when it EXECUTES.
@MainActor
final class PhoneQueuedLoopRevalidationTests: XCTestCase {
    func testPureDecision() {
        XCTAssertNil(MobileLoopBridge.executionRefusal(switchAllowed: true, deniedMessage: "d",
                                                       projectAtReceipt: "p1", projectNow: "p1"))
        XCTAssertEqual(MobileLoopBridge.executionRefusal(switchAllowed: false, deniedMessage: "denied",
                                                         projectAtReceipt: "p1", projectNow: "p1"), "denied")
        XCTAssertNotNil(MobileLoopBridge.executionRefusal(switchAllowed: true, deniedMessage: "d",
                                                          projectAtReceipt: "p1", projectNow: "p2"))
        XCTAssertNotNil(MobileLoopBridge.executionRefusal(switchAllowed: true, deniedMessage: "d",
                                                          projectAtReceipt: "p1", projectNow: nil))
    }

    func testSwitchTurnedOffBeforeTheQueuedStartExecutesRefusesIt() async {
        let suite = UserDefaults(suiteName: "phone-loop-reval-\(UUID().uuidString)")!
        let (service, _, _) = PhoneBridgeFixtures.autoTaskService(suite: suite)
        let host = PhoneBridgeSpyHost()
        host.allow(.loopControl)
        let bridge = MobileLoopBridge(host: host, loopLane: service)
        host.loopRequest = .start
        XCTAssertTrue(bridge.handle(type: "loop_start", data: nil))
        host.allowed = []   // flipped off while the start's Task is still loading its snapshot
        for _ in 0..<400 where host.loopReplies.isEmpty { try? await Task.sleep(nanoseconds: 5_000_000) }
        guard case .ack(let accepted, let message)? = host.loopReplies.last else { return XCTFail("no reply") }
        XCTAssertFalse(accepted)
        XCTAssertEqual(message, "denied")
        XCTAssertFalse(service.hasScheduledRun)
    }
}

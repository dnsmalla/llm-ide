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

    /// Security review I2: a desktop-class client's loop start still needs the Mac's confirmation, and a denial
    /// starts nothing (it used to `return true` before asking).
    func testDesktopLoopStartStillAsksTheMacAndADenialRefuses() async {
        let suite = UserDefaults(suiteName: "desktop-loop-confirm-\(UUID().uuidString)")!
        let (service, _, _) = PhoneBridgeFixtures.autoTaskService(suite: suite)
        let host = PhoneBridgeSpyHost()
        host.isDesktopBridge = true
        host.approvalOutcomes = [.denied]
        let bridge = MobileLoopBridge(host: host, loopLane: service)
        let ok = await bridge.confirmOnMac(title: "Start the loop?", lines: ["Loop: x"], stopGeneration: 0,
                                           projectAtReceipt: nil, label: "loop_start")
        XCTAssertFalse(ok)
        XCTAssertEqual(host.approvalRequests.count, 1)
        XCTAssertEqual(host.approvalRequests.first?.requester, "the LLM-IDE desktop app on this Mac")
        guard case .ack(let accepted, _)? = host.loopReplies.last else { return XCTFail("no reply") }
        XCTAssertFalse(accepted)
    }
}

import XCTest
@testable import LlmIdeMacLib

/// A phone `loop_stop` must cancel the running loop, not tear down the Auto
/// Task scheduler: `AutoCodeUpdateService.stop()` invalidates the cron timer,
/// which silently stopped every scheduled task until the app restarted.
@MainActor
final class MobileLoopStopTests: XCTestCase {
    func testPhoneLoopStopLeavesSchedulerTimerRunning() {
        let suite = UserDefaults(suiteName: "mobile-loop-stop-\(UUID().uuidString)")!
        let service = AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: AutoTaskSettings(defaults: suite),
            registry: ProcessedActionsRegistry(
                storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json")),
            logStore: TaskLogStore())
        service.scheduleTimer()
        XCTAssertTrue(service.isSchedulerArmed)

        let manager = MobileControlManager()
        let bridge = MobileLoopBridge(manager: manager, autoCode: service)
        XCTAssertTrue(bridge.handle(type: "loop_stop", data: nil))

        XCTAssertTrue(service.isSchedulerArmed, "phone Stop must not invalidate the scheduler timer")
        service.stop()
        XCTAssertFalse(service.isSchedulerArmed)
    }

    private func makeService() -> AutoCodeUpdateService {
        let suite = UserDefaults(suiteName: "mobile-loop-gate-\(UUID().uuidString)")!
        return AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: AutoTaskSettings(defaults: suite),
            registry: ProcessedActionsRegistry(
                storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json")),
            logStore: TaskLogStore())
    }

    /// A Stop sent while a start is still loading its snapshot cancels the start.
    func testStopSentDuringAStartsAwaitCancelsTheStart() async throws {
        let manager = MobileControlManager()
        let bridge = MobileLoopBridge(manager: manager, autoCode: makeService())
        XCTAssertTrue(bridge.handle(type: "loop_start", data: nil))
        XCTAssertTrue(bridge.handle(type: "loop_stop", data: nil))   // before the start's Task runs
        for _ in 0..<200 where !manager.logLines.contains(where: { $0.text.contains("cancelled by a Stop") }) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(manager.logLines.contains { $0.text == "loop_start cancelled by a Stop sent meanwhile" })
        XCTAssertFalse(manager.logLines.contains { $0.text.hasPrefix("loop_start accepted") })
    }

    func testGateCancelsAStartThatAStopOvertook() {
        var gate = MobileLoopRequestGate()
        let captured = gate.stopGeneration
        gate.noteStop()
        XCTAssertNotEqual(gate.stopGeneration, captured, "the start re-checks and sees the Stop")
        let later = gate.stopGeneration
        XCTAssertEqual(gate.stopGeneration, later, "a start after the Stop is unaffected")
    }

    func testGateDropsAReplyOlderThanOneAlreadyAnswered() {
        var gate = MobileLoopRequestGate()
        let old = gate.issue()
        let new = gate.issue()
        XCTAssertTrue(gate.claim(new, .status), "the newer snapshot finished first")
        XCTAssertFalse(gate.claim(old, .status), "the stale snapshot is dropped")
        XCTAssertTrue(gate.claim(old, .start), "channels are independent")
        let newest = gate.issue()
        XCTAssertTrue(gate.claim(newest, .status))
    }
}

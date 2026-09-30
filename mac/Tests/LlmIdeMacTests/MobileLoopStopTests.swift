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
}

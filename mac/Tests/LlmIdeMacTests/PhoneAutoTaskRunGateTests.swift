import XCTest
@testable import LlmIdeMacLib

/// A phone-started Auto Task run honours the task's own enable flag.
@MainActor
final class PhoneAutoTaskRunGateTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "phone-run-gate-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func makeBridge() -> (MobileAutoTaskBridge, PhoneBridgeSpyHost, AutoCodeUpdateService, AutoTaskSettings) {
        let (service, settings, logs) = PhoneBridgeFixtures.autoTaskService(suite: suite)
        let host = PhoneBridgeSpyHost()
        host.allow(.autoTaskControl)
        let bridge = MobileAutoTaskBridge(host: host, autoCode: service, settings: settings, logStore: logs)
        return (bridge, host, service, settings)
    }

    func testPhoneRunOfADisabledTaskIsRefusedWithTaskDisabled() {
        let (bridge, host, service, settings) = makeBridge()
        XCTAssertFalse(settings.runImplementIssues)
        host.autoTaskRequest = .run(.init(task: "implementIssues"))
        XCTAssertTrue(bridge.handle(type: "auto_task_run", data: nil))
        XCTAssertEqual(host.lastAck?.ok, false)
        XCTAssertEqual(host.lastAck?.code, MobileRefusalCode.taskDisabled)
        XCTAssertFalse(service.hasScheduledRun, "a refused run must not start anything")
    }

    func testEveryDisabledBuiltInIsRefusedNotJustImplement() {
        let (bridge, host, service, settings) = makeBridge()
        for task in AutoTask.allCases where task != .loopEngineering {
            XCTAssertFalse(service.isTaskEnabled(task), "\(task) should default off")
            host.autoTaskReplies = []
            host.autoTaskRequest = .run(.init(task: task.rawValue))
            _ = bridge.handle(type: "auto_task_run", data: nil)
            XCTAssertEqual(host.lastAck?.code, MobileRefusalCode.taskDisabled, task.rawValue)
        }
        XCTAssertFalse(service.hasScheduledRun)
        _ = settings
    }

    func testEnabledTaskStillRunsFromThePhone() {
        let (bridge, host, service, settings) = makeBridge()
        settings.setEnabled(true, task: .reviewCode)
        host.autoTaskRequest = .run(.init(task: "reviewCode"))
        XCTAssertTrue(bridge.handle(type: "auto_task_run", data: nil))
        XCTAssertNotEqual(host.lastAck?.code, MobileRefusalCode.taskDisabled)
        XCTAssertTrue(service.hasScheduledRun)
        service.cancel()
    }
}

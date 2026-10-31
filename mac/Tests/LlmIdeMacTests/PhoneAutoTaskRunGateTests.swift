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

/// Templates, per-task config and toggles are desktop-only: the phone keeps read access and gets a
/// typed `desktop_only` refusal for every write, even with the Auto Task switch on.
@MainActor
final class PhoneAutoTaskDesktopOnlyTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "phone-desktop-only-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testEveryWriteIsRefusedDesktopOnlyAndChangesNothing() {
        let (service, settings, logs) = PhoneBridgeFixtures.autoTaskService(suite: suite)
        let host = PhoneBridgeSpyHost()
        host.allow(.autoTaskControl)
        let bridge = MobileAutoTaskBridge(host: host, autoCode: service, settings: settings, logStore: logs)

        let writes: [(String, MobileAutoTaskRequest)] = [
            ("auto_task_config_set", .configSet(.init(taskId: "reviewCode", inputPath: nil, outputPath: nil,
                                                      skillName: nil, templateId: nil))),
            ("auto_task_template_save", .templateSave(.init(id: nil, name: "x", body: "y"))),
            ("auto_task_template_rename", .templateRename(.init(id: "a", name: "b"))),
            ("auto_task_template_delete", .templateDelete(.init(id: "a"))),
            ("auto_task_toggle", .toggle(.init(task: "reviewCode", enabled: true))),
            ("auto_task_toggle", .toggle(.init(task: nil, enabled: true))),
            ("auto_task_toggle", .toggle(nil)),
        ]
        for (type, request) in writes {
            host.commandErrors = []
            host.autoTaskRequest = request
            XCTAssertTrue(bridge.handle(type: type, data: nil), type)
            XCTAssertEqual(host.commandErrors.first?.code, MobileRefusalCode.desktopOnly, "\(type) \(request)")
        }
        XCTAssertFalse(settings.runReviewCode, "a refused toggle must not flip the flag")
        XCTAssertFalse(settings.enabled, "a refused master toggle must not flip the master switch")
    }

    func testReadsStillWork() {
        let (service, settings, logs) = PhoneBridgeFixtures.autoTaskService(suite: suite)
        let host = PhoneBridgeSpyHost()
        let bridge = MobileAutoTaskBridge(host: host, autoCode: service, settings: settings, logStore: logs)
        host.autoTaskRequest = .list
        XCTAssertTrue(bridge.handle(type: "auto_task_list", data: nil))
        let gotState = host.autoTaskReplies.contains { if case .state = $0 { return true } else { return false } }
        XCTAssertTrue(gotState, "the phone keeps read access to status")
        XCTAssertTrue(host.commandErrors.isEmpty)
    }

    func testRefusalWorksEvenWhenTheSwitchIsOff() {
        let (service, settings, logs) = PhoneBridgeFixtures.autoTaskService(suite: suite)
        let host = PhoneBridgeSpyHost()   // switch NOT allowed
        let bridge = MobileAutoTaskBridge(host: host, autoCode: service, settings: settings, logStore: logs)
        host.autoTaskRequest = .templateSave(.init(id: nil, name: "x", body: "y"))
        _ = bridge.handle(type: "auto_task_template_save", data: nil)
        XCTAssertEqual(host.commandErrors.first?.code, MobileRefusalCode.desktopOnly)
    }
}

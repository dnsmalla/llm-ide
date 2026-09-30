import XCTest
@testable import LlmIdeMacLib

/// The loop lane is separate from the Auto Task slot: a loop never blocks the
/// other tasks, they never block it, two sweeps never overlap, and each Stop
/// reaches only its own lane.
@MainActor
final class AutoCodeUpdateServiceLoopLaneTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "svc-lane-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName); suite = nil
        super.tearDown()
    }

    private func makeService() -> AutoCodeUpdateService {
        let settings = AutoTaskSettings(defaults: suite)
        settings.enabled = true
        for task in [AutoTask.reviewCode, .loopEngineering] {
            settings.setEnabled(true, task: task)
            settings.setScheduleActive(true, for: task)
            settings.setCron("*/30 * * * *", for: task)
        }
        return AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite), autoTaskSettings: settings,
            registry: ProcessedActionsRegistry(
                storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json")),
            logStore: TaskLogStore())
    }

    private func makeDue(_ svc: AutoCodeUpdateService, _ task: AutoTask) {
        svc.autoTaskSettings.setNextFireAt(Date().addingTimeInterval(-300), for: task)
    }

    /// A lane body that runs until cancelled and records that it saw it.
    private final class Flag { var cancelled = false; var finished = false }
    private func spin(_ flag: Flag) -> @MainActor () async -> Void {
        { while !Task.isCancelled { await Task.yield() }; flag.cancelled = true; flag.finished = true }
    }

    func testLoopStartsOnItsLaneWhileTheAutoTaskSlotIsBusy() {
        let svc = makeService()
        XCTAssertTrue(svc.runNow())                      // occupies runTask (not yet executing)
        makeDue(svc, .loopEngineering)
        let before = svc.autoTaskSettings.nextFireAt(for: .loopEngineering)

        XCTAssertTrue(svc.runDue(), "the loop must not wait for the Auto Task slot")
        XCTAssertTrue(svc.hasScheduledLoopRun)
        XCTAssertNotEqual(svc.autoTaskSettings.nextFireAt(for: .loopEngineering), before, "realigned = started")
        svc.cancelLoopLane()
        svc.cancel()
    }

    func testNonLoopTaskStartsWhileTheLoopLaneIsBusy() {
        let svc = makeService()
        let flag = Flag()
        XCTAssertTrue(svc.startLoopLane(spin(flag)))
        makeDue(svc, .reviewCode)
        let before = svc.autoTaskSettings.nextFireAt(for: .reviewCode)

        XCTAssertTrue(svc.runDue(), "a running loop must not block other Auto Tasks")
        XCTAssertNotEqual(svc.autoTaskSettings.nextFireAt(for: .reviewCode), before)
        svc.cancelLoopLane()
        svc.cancel()
    }

    func testDueLoopIsSkippedNotOverlappedWhileTheLaneIsBusy() {
        let svc = makeService()
        let flag = Flag()
        XCTAssertTrue(svc.startLoopLane(spin(flag)))
        makeDue(svc, .loopEngineering)
        let before = svc.autoTaskSettings.nextFireAt(for: .loopEngineering)

        XCTAssertFalse(svc.runDue(), "nothing else is due and the lane is busy")
        XCTAssertEqual(svc.autoTaskSettings.nextFireAt(for: .loopEngineering), before, "stays due for the next tick")
        svc.cancelLoopLane()
    }

    func testSecondSweepIsRefusedWithAVisibleMessage() {
        let svc = makeService()
        let flag = Flag()
        XCTAssertTrue(svc.startLoopLane(spin(flag)))
        XCTAssertFalse(svc.startLoopLane({}))
        XCTAssertEqual(svc.statusMessage, AutoCodeUpdateService.loopBusyMessage)
        XCTAssertFalse(svc.runSingleLoop(loopId: "primary"))
        svc.cancelLoopLane()
    }

    func testStopScopeEachCancelReachesOnlyItsOwnLane() async {
        let svc = makeService()
        let flag = Flag()
        XCTAssertTrue(svc.startLoopLane(spin(flag)))
        svc.cancel()                                     // Auto Tasks' Stop
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(flag.cancelled, "Auto Task Stop must not kill a running loop")

        svc.cancelLoopLane()
        for _ in 0..<200 where !flag.finished { await Task.yield() }
        XCTAssertTrue(flag.cancelled)
    }
}

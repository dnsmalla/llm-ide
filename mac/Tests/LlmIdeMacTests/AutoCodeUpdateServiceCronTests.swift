import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoCodeUpdateServiceCronTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "svc-cron-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName); suite = nil
        super.tearDown()
    }

    /// Minimal stand-in: we only test the scheduling DECISION (dueTasks + the
    /// nextFireAt realign), not the task bodies. Build via the real init.
    ///
    /// Init-signature note: the brief's draft used `AppConfig(defaults:)` and
    /// `ProcessedActionsRegistry()`, but the real signatures are
    /// `AppConfig(userDefaults:)` and `ProcessedActionsRegistry(storeURL:)`.
    /// Adapted here minimally — the service's real init is otherwise invoked
    /// unchanged. The registry points at a fresh temp path; we never call
    /// `start()`/`bootstrap()`, so the file need not exist (the pure methods
    /// under test only touch `autoTaskSettings`).
    private func makeService() -> AutoCodeUpdateService {
        let settings = AutoTaskSettings(defaults: suite)
        settings.enabled = true
        settings.setEnabled(true, task: .reviewCode)
        // The schedule is opt-in, so arm it explicitly — without this the
        // fixture would have a cron and no fire, and every test here would
        // pass vacuously.
        settings.setScheduleActive(true, for: .reviewCode)
        settings.setCron("*/30 * * * *", for: .reviewCode)
        let registry = ProcessedActionsRegistry(
            storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json"))
        return AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: settings,
            registry: registry,
            logStore: TaskLogStore())
    }

    func testOverdueTaskIsDueAndRealigns() {
        let svc = makeService()
        let settings = svc.autoTaskSettings
        let past = Date().addingTimeInterval(-300)   // 5 min ago
        settings.setNextFireAt(past, for: .reviewCode)

        let due = svc.dueTasks(now: Date())
        XCTAssertEqual(due, [.reviewCode])

        // runDue realigns nextFireAt to strictly-after-now (we call the realign
        // path directly to avoid running task bodies in this unit test).
        svc.realignNextFire(for: .reviewCode, now: Date())
        XCTAssertGreaterThan(settings.nextFireAt(for: .reviewCode)!, Date())
    }

    func testFutureTaskIsNotDue() {
        let svc = makeService()
        svc.autoTaskSettings.setNextFireAt(Date().addingTimeInterval(3600), for: .reviewCode)
        XCTAssertTrue(svc.dueTasks(now: Date()).isEmpty)
    }

    func testMasterDisabledSkipsAll() {
        let svc = makeService()
        svc.autoTaskSettings.enabled = false
        svc.autoTaskSettings.setNextFireAt(Date().addingTimeInterval(-300), for: .reviewCode)
        XCTAssertTrue(svc.dueTasks(now: Date()).isEmpty)
    }

    func testPerTaskDisabledSkipsTask() {
        let svc = makeService()
        svc.autoTaskSettings.setEnabled(false, task: .reviewCode)
        svc.autoTaskSettings.setNextFireAt(Date().addingTimeInterval(-300), for: .reviewCode)
        XCTAssertTrue(svc.dueTasks(now: Date()).isEmpty)
    }
    /// A stale fire from a build that had no Active flag must not produce one
    /// last unwanted run before the realign clears it.
    func testInactiveScheduleIsNeverDueEvenWithAStaleFire() {
        let svc = makeService()
        svc.autoTaskSettings.setScheduleActive(false, for: .reviewCode)
        svc.autoTaskSettings.setNextFireAt(Date().addingTimeInterval(-300), for: .reviewCode)
        XCTAssertTrue(svc.dueTasks(now: Date()).isEmpty)
    }

    /// The post-run realign must not re-arm a task the user deactivated.
    func testRealignDoesNotReArmAnInactiveSchedule() {
        let svc = makeService()
        svc.autoTaskSettings.setScheduleActive(false, for: .reviewCode)
        svc.realignNextFire(for: .reviewCode, now: Date())
        XCTAssertNil(svc.autoTaskSettings.nextFireAt(for: .reviewCode))
    }

}

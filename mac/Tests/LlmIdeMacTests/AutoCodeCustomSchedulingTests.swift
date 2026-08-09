import XCTest
@testable import LlmIdeMacLib

/// Scheduling-decision tests for user-created (`CustomAutoTask`) cron runs —
/// the parallel of `AutoCodeUpdateServiceCronTests` for built-in tasks. These
/// exercise ONLY the pure decision layer (`dueCustomTasks` +
/// `realignCustomNextFire`); task bodies (`runCustomTask`) are covered
/// elsewhere. Built the same way `AutoCodeUpdateServiceCronTests.makeService()`
/// builds its service: `AppConfig(userDefaults: suite)` +
/// `AutoTaskSettings(defaults: suite)` share one isolated suite, and custom
/// tasks are seeded with `t.save(in: suite)`. `dueCustomTasks` reads them back
/// via `config.userDefaults` (the same suite), so nothing touches `.standard`.
@MainActor
final class AutoCodeCustomSchedulingTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "svc-custom-cron-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName); suite = nil
        super.tearDown()
    }

    private func makeService() -> AutoCodeUpdateService {
        let settings = AutoTaskSettings(defaults: suite)
        settings.enabled = true
        let registry = ProcessedActionsRegistry(
            storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json"))
        return AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: settings,
            registry: registry,
            logStore: TaskLogStore())
    }

    func testDueCustomTasksRequiresCronAndPastFire() {
        let svc = makeService()
        let now = Date()
        let past = now.addingTimeInterval(-300)   // 5 min ago; > 0 sentinel
        var t = CustomAutoTask(name: "Scheduled", template: "p")
        t.cron = "0 * * * *"
        t.save(in: suite)

        // No customNextFireAt seeded yet → not due.
        XCTAssertFalse(svc.dueCustomTasks(now: now).contains { $0.id == t.id })

        // Seed a fire in the past → due.
        svc.autoTaskSettings.setCustomNextFireAt(past, for: t.id)
        XCTAssertTrue(svc.dueCustomTasks(now: now).contains { $0.id == t.id })
    }

    func testManualCustomTaskNeverDue() {
        let svc = makeService()
        var t = CustomAutoTask(name: "Manual", template: "p")   // cron nil
        t.cron = nil
        t.save(in: suite)
        // Even with a past fire, a manual (cron-less) task is never auto-scheduled.
        svc.autoTaskSettings.setCustomNextFireAt(Date().addingTimeInterval(-300), for: t.id)
        XCTAssertFalse(svc.dueCustomTasks(now: Date()).contains { $0.id == t.id })
    }

    func testDisabledCustomTaskNeverDue() {
        let svc = makeService()
        var t = CustomAutoTask(name: "Disabled", template: "p")
        t.cron = "0 * * * *"
        t.isEnabled = false
        t.save(in: suite)
        svc.autoTaskSettings.setCustomNextFireAt(Date().addingTimeInterval(-300), for: t.id)
        XCTAssertFalse(svc.dueCustomTasks(now: Date()).contains { $0.id == t.id })
    }

    func testMasterDisabledSkipsCustomTasks() {
        let svc = makeService()
        svc.autoTaskSettings.enabled = false
        var t = CustomAutoTask(name: "Scheduled", template: "p")
        t.cron = "0 * * * *"
        t.save(in: suite)
        svc.autoTaskSettings.setCustomNextFireAt(Date().addingTimeInterval(-300), for: t.id)
        XCTAssertTrue(svc.dueCustomTasks(now: Date()).isEmpty)
    }

    func testRealignCustomNextFirePushesFuture() {
        let svc = makeService()
        let now = Date()
        var t = CustomAutoTask(name: "Scheduled", template: "p")
        t.cron = "0 * * * *"   // hourly
        t.save(in: suite)
        // Seed a fire in the past, then realign to strictly after now.
        svc.autoTaskSettings.setCustomNextFireAt(now.addingTimeInterval(-3600), for: t.id)
        svc.realignCustomNextFire(for: t, now: now)
        let next = svc.autoTaskSettings.customNextFireAt(for: t.id)
        XCTAssertNotNil(next)
        XCTAssertGreaterThan(next!, now)
    }

    func testRealignCustomNextFireClearsWhenCronNil() {
        let svc = makeService()
        var t = CustomAutoTask(name: "Manual", template: "p")
        t.cron = nil
        t.save(in: suite)
        svc.autoTaskSettings.setCustomNextFireAt(Date().addingTimeInterval(-300), for: t.id)
        svc.realignCustomNextFire(for: t, now: Date())
        XCTAssertNil(svc.autoTaskSettings.customNextFireAt(for: t.id))
    }
}

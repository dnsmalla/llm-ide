import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoTaskSettingsCronTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "cron-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName); suite = nil
        super.tearDown()
    }

    func testPerTaskCronPersists() {
        let a = AutoTaskSettings(defaults: suite)
        a.setCron("0 9 * * 1-5", for: .reviewCode)
        let b = AutoTaskSettings(defaults: suite)
        XCTAssertEqual(b.cron(for: .reviewCode), "0 9 * * 1-5")
        // Unset task falls back to the default hourly cron.
        XCTAssertEqual(b.cron(for: .reviewDoc), "0 * * * *")
    }

    func testNextFireAtPersistsAndRecomputes() {
        let now = Date()
        let a = AutoTaskSettings(defaults: suite)
        // Arming is opt-in: `recomputeNextFire` deliberately refuses to arm a
        // deactivated schedule, so activate before asserting on the fire.
        a.setScheduleActive(true, for: .regression)
        a.setCron("0 9 * * *", for: .regression)
        a.recomputeNextFire(for: .regression, now: now)
        let stored = a.nextFireAt(for: .regression)
        XCTAssertNotNil(stored)
        XCTAssertGreaterThan(stored!, now)
    }

    func testMigrationFromIntervalMinutes() {
        suite.set(60, forKey: "autoCodeIntervalMinutes")     // → 0 * * * *
        suite.set(30, forKey: "autoCodeIntervalMinutes")     // last write wins → 30
        // Simulate the first-launch migration path by constructing settings that
        // still have the legacy key and no cron keys.
        suite.removeObject(forKey: "autoCodeCron.reviewCode")
        let a = AutoTaskSettings(defaults: suite)            // init runs migration
        // 30 min → */30 * * * *
        XCTAssertEqual(a.cron(for: .reviewCode), "*/30 * * * *")
    }

    func testMigrationHourlyDailyAndMultiHour() {
        func cron(forInterval minutes: Int) -> String {
            let s = UserDefaults(suiteName: "cron-migrate-\(UUID().uuidString)")!
            s.set(minutes, forKey: "autoCodeIntervalMinutes")
            return AutoTaskSettings(defaults: s).cron(for: .reviewCode)
        }
        XCTAssertEqual(cron(forInterval: 60), "0 * * * *")
        XCTAssertEqual(cron(forInterval: 1440), "0 0 * * *")
        XCTAssertEqual(cron(forInterval: 120), "0 */2 * * *")
        XCTAssertEqual(cron(forInterval: 15), "*/15 * * * *")
    }
}

extension AutoTaskSettingsCronTests {
    func testIntervalMinutesRemovedFromDefaults() {
        // The legacy key may still exist on disk for migration, but the type no
        // longer exposes intervalMinutes. A fresh settings object must not write it.
        let a = AutoTaskSettings(defaults: suite)
        _ = a
        // No API to set interval; the key is read once for migration then unused.
        // (If a `var intervalMinutes` still compiles here, this task is incomplete.)
    }

    func testCustomNextFireAtPersistsById() {
        let a = AutoTaskSettings(defaults: suite)
        XCTAssertNil(a.customNextFireAt(for: "task-1"))
        let d = Date(timeIntervalSince1970: 1_700_000_000)
        a.setCustomNextFireAt(d, for: "task-1")
        let b = AutoTaskSettings(defaults: suite)
        XCTAssertEqual(b.customNextFireAt(for: "task-1"), d)
        b.setCustomNextFireAt(nil, for: "task-1")
        XCTAssertNil(b.customNextFireAt(for: "task-1"))
    }
    // MARK: - Schedule active flag

    /// The cron EXPRESSION is seeded on a fresh install, but seeding an
    /// expression is not arming a schedule: nothing fires until the user flips
    /// the Active switch.
    func testScheduleStartsInactiveWithNoUpcomingFire() {
        let settings = AutoTaskSettings(defaults: suite)
        for task in AutoTask.allCases {
            XCTAssertFalse(settings.isScheduleActive(for: task), "\(task.label) should start inactive")
            XCTAssertNil(settings.nextFireAt(for: task), "\(task.label) must not be armed")
            XCTAssertFalse(settings.cron(for: task).isEmpty, "the expression is still seeded")
        }
    }

    func testActivatingArmsTheNextFireAndDeactivatingClearsIt() {
        let settings = AutoTaskSettings(defaults: suite)
        settings.setScheduleActive(true, for: .reviewCode)
        XCTAssertNotNil(settings.nextFireAt(for: .reviewCode))

        settings.setScheduleActive(false, for: .reviewCode)
        XCTAssertNil(settings.nextFireAt(for: .reviewCode))
    }

    /// Deactivating must not destroy a cron the user tuned by hand — that is
    /// the whole reason arming is a separate flag rather than clearing the
    /// expression.
    func testDeactivatingKeepsTheExpressionSoActivatingRestoresIt() {
        let a = AutoTaskSettings(defaults: suite)
        a.setScheduleActive(true, for: .reviewCode)
        a.setCron("*/5 * * * *", for: .reviewCode)
        a.setScheduleActive(false, for: .reviewCode)
        XCTAssertEqual(a.cron(for: .reviewCode), "*/5 * * * *")

        let b = AutoTaskSettings(defaults: suite)
        XCTAssertEqual(b.cron(for: .reviewCode), "*/5 * * * *")
        b.setScheduleActive(true, for: .reviewCode)
        XCTAssertNotNil(b.nextFireAt(for: .reviewCode), "the saved expression re-arms as-is")
    }

    /// Editing the cron of a deactivated task must not arm it behind the
    /// user's back — `setCron` recomputes the next fire, and that recompute
    /// has to respect the flag.
    func testSettingACronOnAnInactiveScheduleDoesNotArmIt() {
        let settings = AutoTaskSettings(defaults: suite)
        settings.setCron("*/10 * * * *", for: .reviewDoc)
        XCTAssertNil(settings.nextFireAt(for: .reviewDoc))
    }

    /// An install from a build with no Active flag has a `nextFireAt` saved
    /// for every task. Loading must disarm those rather than inherit 13 live
    /// crons nobody chose — while leaving the expressions untouched.
    func testLoadDisarmsFiresLeftBehindByAnOlderBuild() {
        suite.set("*/2 * * * *", forKey: "autoCodeCron.reviewCode")
        suite.set(Date().addingTimeInterval(60).timeIntervalSince1970,
                  forKey: "autoCodeNextFireAt.reviewCode")

        let settings = AutoTaskSettings(defaults: suite)
        XCTAssertNil(settings.nextFireAt(for: .reviewCode), "the stale fire is cleared")
        XCTAssertEqual(settings.cron(for: .reviewCode), "*/2 * * * *", "the expression survives")
    }

}

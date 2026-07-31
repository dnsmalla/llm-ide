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

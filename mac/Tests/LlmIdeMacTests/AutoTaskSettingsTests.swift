import XCTest
@testable import LlmIdeMacLib

/// `AutoTaskSettings.showOnlyEnabledTasks` persistence — the flag that drives the
/// Auto Tasks page filter. Uses a throwaway UserDefaults suite so nothing leaks
/// into the app's real defaults. (`AutoTaskSettings` is `@MainActor`.)
@MainActor
final class AutoTaskSettingsTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "auto-task-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testShowOnlyEnabledTasksDefaultsFalse() {
        let settings = AutoTaskSettings(defaults: suite)
        XCTAssertFalse(settings.showOnlyEnabledTasks)
    }

    func testShowOnlyEnabledTasksPersistsAcrossInstances() {
        let a = AutoTaskSettings(defaults: suite)
        a.showOnlyEnabledTasks = true

        // A fresh instance backed by the same defaults reads the persisted value.
        let b = AutoTaskSettings(defaults: suite)
        XCTAssertTrue(b.showOnlyEnabledTasks)
    }

    func testShowOnlyEnabledTasksRoundTripOff() {
        let a = AutoTaskSettings(defaults: suite)
        a.showOnlyEnabledTasks = true
        a.showOnlyEnabledTasks = false

        let b = AutoTaskSettings(defaults: suite)
        XCTAssertFalse(b.showOnlyEnabledTasks)
    }
}

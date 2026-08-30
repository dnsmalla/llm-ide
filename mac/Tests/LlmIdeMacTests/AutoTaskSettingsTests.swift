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

    /// Auto Tasks are opt-in: a fresh install has NO task enabled, so turning
    /// the master switch on cannot start work the user never chose.
    func testEveryTaskDefaultsDisabled() {
        let settings = AutoTaskSettings(defaults: suite)
        XCTAssertFalse(settings.enabled, "the master switch is off too")
        for task in AutoTask.allCases {
            XCTAssertFalse(settings.isEnabled(task: task), "\(task.label) should default off")
        }
        XCTAssertTrue(settings.enabledTasks.isEmpty)
    }

    /// A task the user switched on stays on — the default only applies while
    /// no key has been written for that task.
    func testExplicitlyEnabledTaskSurvivesTheDefault() {
        let a = AutoTaskSettings(defaults: suite)
        a.setEnabled(true, task: .reviewCode)

        let b = AutoTaskSettings(defaults: suite)
        XCTAssertTrue(b.isEnabled(task: .reviewCode))
        XCTAssertFalse(b.isEnabled(task: .reviewDoc))
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

import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoTaskSettingsLoopEngineeringTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "auto-task-settings-loop-engineering-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testDefaultsToFalse() {
        let settings = AutoTaskSettings(defaults: suite)
        XCTAssertFalse(settings.runLoopEngineering)
        XCTAssertFalse(settings.isEnabled(task: .loopEngineering))
    }

    func testSetEnabledPersistsAcrossInstances() {
        let a = AutoTaskSettings(defaults: suite)
        a.setEnabled(true, task: .loopEngineering)
        let b = AutoTaskSettings(defaults: suite)
        XCTAssertTrue(b.runLoopEngineering)
        XCTAssertTrue(b.isEnabled(task: .loopEngineering))
    }

    func testEnabledTasksIncludesLoopEngineeringWhenOn() {
        let settings = AutoTaskSettings(defaults: suite)
        settings.runLoopEngineering = true
        XCTAssertTrue(settings.enabledTasks.contains("Loop Engineering"))
    }
}

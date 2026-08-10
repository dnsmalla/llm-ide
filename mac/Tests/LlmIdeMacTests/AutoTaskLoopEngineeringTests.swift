import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoTaskLoopEngineeringTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "auto-task-loop-engineering-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testLoopEngineeringIsInAllCases() {
        XCTAssertTrue(AutoTask.allCases.contains(.loopEngineering))
    }

    func testLoopEngineeringLabelAndIcon() {
        // The UI label is "Loop"; the enum's rawValue stays `loopEngineering`
        // because it keys taskErrors and the persisted AutoTaskSettings toggles.
        XCTAssertEqual(AutoTask.loopEngineering.label, "Loop")
        XCTAssertEqual(AutoTask.loopEngineering.rawValue, "loopEngineering")
        XCTAssertFalse(AutoTask.loopEngineering.icon.isEmpty)
    }

    func testLoopEngineeringLogSuffix() {
        XCTAssertEqual(AutoTask.loopEngineering.logSuffix, "loop-engineering")
    }

    func testLoopEngineeringIsStructuralWithNoTemplate() {
        XCTAssertTrue(AutoTask.loopEngineering.isStructural)
        XCTAssertNil(AutoTask.loopEngineering.templateBinding(config: AppConfig(userDefaults: suite)))
    }

    func testLoopEngineeringRequiresLinkedRepo() {
        XCTAssertTrue(AutoTask.loopEngineering.requiresLinkedRepo)
    }
}

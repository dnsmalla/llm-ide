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
        XCTAssertEqual(AutoTask.loopEngineering.label, "Loop Engineering")
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

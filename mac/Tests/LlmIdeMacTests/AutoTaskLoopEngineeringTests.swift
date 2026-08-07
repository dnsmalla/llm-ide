import XCTest
@testable import LlmIdeMacLib

final class AutoTaskLoopEngineeringTests: XCTestCase {
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
    }

    func testLoopEngineeringRequiresLinkedRepo() {
        XCTAssertTrue(AutoTask.loopEngineering.requiresLinkedRepo)
    }
}

import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ShellStateSectionTests: XCTestCase {
    /// Loop Engineering is the permanent home for regression and must
    /// always be reachable — it can't be hidden via Settings like the
    /// ordinary tool sections.
    func testLoopEngineeringIsNotUserHideable() {
        XCTAssertFalse(
            ShellState.Section.userHideable.contains(.loopEngine),
            "Loop Engineering must not be user-hideable"
        )
    }
}

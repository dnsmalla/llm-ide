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

    /// The standalone Regression page is gone; the enum must no longer
    /// carry it and nothing should reference the retired raw value.
    func testRegressionSectionIsRetired() {
        XCTAssertNil(ShellState.Section(rawValue: "regression"))
        XCTAssertFalse(ShellState.Section.userHideable.contains { $0.rawValue == "regression" })
        XCTAssertFalse(ShellState.Section.allCases.contains { $0.rawValue == "regression" })
    }
}

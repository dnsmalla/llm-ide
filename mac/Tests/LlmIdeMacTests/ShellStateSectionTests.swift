import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ShellStateSectionTests: XCTestCase {
    /// The Loop's toolbar button is hideable via Settings → Workspace. It was
    /// deliberately excluded before, on the grounds that it is the permanent home
    /// for regression — hiding it is only acceptable because the page stays
    /// reachable without its button (see `testHidingASectionDoesNotRemoveItFromTheEnum`
    /// and the `.openSection` handler, which never consults the hidden set).
    func testLoopIsUserHideable() {
        XCTAssertTrue(
            ShellState.Section.userHideable.contains(.loopEngine),
            "the Loop section should be hideable from the top bar"
        )
    }

    /// The three that must never become hideable: Library is the fallback landing
    /// that every redirect assumes exists, Settings is the only way back once
    /// everything else is hidden, and Live is already gated on capture state.
    func testLibraryLiveAndSettingsAreNeverHideable() {
        for section in [ShellState.Section.library, .live, .settings] {
            XCTAssertFalse(ShellState.Section.userHideable.contains(section),
                           "\(section.rawValue) must not be user-hideable")
        }
    }

    /// Hiding removes the toolbar button, not the section — `.openSection` sets the
    /// section directly, which is what keeps Settings → Loop's "Open Loop" button,
    /// the menu-bar status rows and the chat command working while it is hidden.
    func testHidingASectionDoesNotRemoveItFromTheEnum() {
        XCTAssertNotNil(ShellState.Section(rawValue: "loopEngine"))
        XCTAssertTrue(ShellState.Section.allCases.contains(.loopEngine))
    }

    /// Home falls back to Library when the chosen landing is hidden — so picking
    /// Loop as Home and then hiding it lands somewhere real instead of nowhere.
    func testHomeFallsBackToLibraryWhenLoopIsHiddenAndWasHome() {
        let allCompiled = Set(AppFeature.allCases)
        XCTAssertEqual(
            ShellState.Section.resolveHome("loopEngine", hidden: ["loopEngine"], compiled: allCompiled), .library)
        XCTAssertEqual(
            ShellState.Section.resolveHome("loopEngine", hidden: [], compiled: allCompiled), .loopEngine)
    }

    /// The standalone Regression page is gone; the enum must no longer
    /// carry it and nothing should reference the retired raw value.
    func testRegressionSectionIsRetired() {
        XCTAssertNil(ShellState.Section(rawValue: "regression"))
        XCTAssertFalse(ShellState.Section.userHideable.contains { $0.rawValue == "regression" })
        XCTAssertFalse(ShellState.Section.allCases.contains { $0.rawValue == "regression" })
    }
}

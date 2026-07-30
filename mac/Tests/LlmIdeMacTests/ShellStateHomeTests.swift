import XCTest
@testable import LlmIdeMacLib

/// `ShellState.Section.resolveHome` — the pure rule that decides where the Home
/// button goes. (`ShellState` is `@MainActor`, so its static is too.)
@MainActor
final class ShellStateHomeTests: XCTestCase {
    func testDefaultExplorerWhenNothingHidden() {
        XCTAssertEqual(ShellState.Section.resolveHome("explorer", hidden: []), .explorer)
    }

    func testChosenSectionReturnedWhenVisible() {
        XCTAssertEqual(ShellState.Section.resolveHome("gantt", hidden: []), .gantt)
        // Other sections being hidden doesn't affect a visible choice.
        XCTAssertEqual(ShellState.Section.resolveHome("issues", hidden: ["gantt"]), .issues)
    }

    func testChosenHiddenFallsBackToLibrary() {
        XCTAssertEqual(ShellState.Section.resolveHome("explorer", hidden: ["explorer"]), .library)
        XCTAssertEqual(ShellState.Section.resolveHome("gantt", hidden: ["gantt"]), .library)
    }

    func testInvalidRawValueFallsBackToLibrary() {
        XCTAssertEqual(ShellState.Section.resolveHome("bogus", hidden: []), .library)
    }

    func testLibraryIsAlwaysItself() {
        XCTAssertEqual(ShellState.Section.resolveHome("library", hidden: []), .library)
    }
}

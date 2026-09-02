import XCTest
@testable import LlmIdeMacLib

/// `ShellState.Section.resolveHome` — the pure rule that decides where the Home
/// button goes. (`ShellState` is `@MainActor`, so its static is too.)
@MainActor
final class ShellStateHomeTests: XCTestCase {
    /// Every section's `backingFeature` is compiled — the common case, and
    /// the value every pre-existing test here used implicitly before
    /// `resolveHome` took a `compiled` parameter.
    private let allCompiled = Set(AppFeature.allCases)

    func testDefaultExplorerWhenNothingHidden() {
        XCTAssertEqual(ShellState.Section.resolveHome("explorer", hidden: [], compiled: allCompiled), .explorer)
    }

    func testChosenSectionReturnedWhenVisible() {
        XCTAssertEqual(ShellState.Section.resolveHome("gantt", hidden: [], compiled: allCompiled), .gantt)
        // Other sections being hidden doesn't affect a visible choice.
        XCTAssertEqual(ShellState.Section.resolveHome("issues", hidden: ["gantt"], compiled: allCompiled), .issues)
    }

    func testChosenHiddenFallsBackToLibrary() {
        XCTAssertEqual(ShellState.Section.resolveHome("explorer", hidden: ["explorer"], compiled: allCompiled), .library)
        XCTAssertEqual(ShellState.Section.resolveHome("gantt", hidden: ["gantt"], compiled: allCompiled), .library)
    }

    func testInvalidRawValueFallsBackToLibrary() {
        XCTAssertEqual(ShellState.Section.resolveHome("bogus", hidden: [], compiled: allCompiled), .library)
    }

    func testLibraryIsAlwaysItself() {
        XCTAssertEqual(ShellState.Section.resolveHome("library", hidden: [], compiled: allCompiled), .library)
    }

    /// Important 1 — a lite build whose home section names a compiled-out
    /// feature (e.g. `.explorer` with fileExplorer excluded) must land on
    /// Library instead of the "not installed" placeholder.
    func testFallsBackToLibraryWhenHomeSectionsFeatureIsNotCompiled() {
        let withoutExplorer = allCompiled.subtracting([.fileExplorer])
        XCTAssertEqual(
            ShellState.Section.resolveHome("explorer", hidden: [], compiled: withoutExplorer), .library)
        // Not hidden and its feature IS compiled: chosen section wins.
        XCTAssertEqual(
            ShellState.Section.resolveHome("gantt", hidden: [], compiled: withoutExplorer), .gantt)
        // A section with no backingFeature at all is never affected.
        XCTAssertEqual(
            ShellState.Section.resolveHome("loopEngine", hidden: [], compiled: withoutExplorer), .loopEngine)
    }

    /// Pin the Section → AppFeature mapping so a future edit to
    /// `backingFeature` (adding/removing a case's gate) is a deliberate,
    /// reviewed change rather than a silent drift — `resolveHome`,
    /// AppShell's toolbar filter, and the Settings "Home opens" picker all
    /// depend on this single switch staying accurate.
    func testBackingFeatureMappingIsPinned() {
        let mapped = Set(ShellState.Section.allCases.compactMap(\.backingFeature))
        XCTAssertEqual(mapped, [.codeGraph3D, .autoTasks, .ganttIssues, .docGen, .fileExplorer])
    }
}

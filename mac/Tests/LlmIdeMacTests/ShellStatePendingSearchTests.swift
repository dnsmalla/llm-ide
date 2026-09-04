import XCTest
@testable import LlmIdeMacLib

/// The Explorer → Search "Find in Folder" handoff. A stored property rather
/// than a `Notification` because switching sections is what MOUNTS
/// `SearchView` — a notification posted at switch time would be delivered
/// before any observer existed.
@MainActor
final class ShellStatePendingSearchTests: XCTestCase {

    func testPendingSearchIncludeStartsNil() {
        XCTAssertNil(ShellState().pendingSearchInclude)
    }

    func testTakeReturnsTheValueAndClearsIt() {
        let shell = ShellState()
        shell.pendingSearchInclude = "app/job/"
        XCTAssertEqual(shell.takePendingSearchInclude(), "app/job/")
        XCTAssertNil(shell.pendingSearchInclude,
                     "a consumed handoff must not re-apply on the next mount")
    }

    func testTakeOnAnEmptyStateIsNil() {
        XCTAssertNil(ShellState().takePendingSearchInclude())
    }

    /// The empty string is a MEANINGFUL value here — it is what
    /// `ExplorerPaths.includeGlob` returns for the root itself ("search
    /// everything") — so it must round-trip rather than reading as absent.
    func testEmptyStringRoundTripsAsAValue() {
        let shell = ShellState()
        shell.pendingSearchInclude = ""
        XCTAssertEqual(shell.takePendingSearchInclude(), "")
        XCTAssertNil(shell.pendingSearchInclude)
    }

    /// A second take must not resurrect the first value.
    func testSecondTakeIsNil() {
        let shell = ShellState()
        shell.pendingSearchInclude = "docs/"
        _ = shell.takePendingSearchInclude()
        XCTAssertNil(shell.takePendingSearchInclude())
    }

    /// The glob the Explorer actually hands over, and the disabled case the
    /// menu item gates on. Search roots at `WorkspaceRoot.resolve` while the
    /// tree roots at `activeProjectCodeDir`, so a folder outside Search's root
    /// is a real state — it must answer `nil`, never a glob that would search
    /// the wrong tree.
    func testIncludeGlobIsWhatGetsHandedOver() {
        let root = URL(fileURLWithPath: "/Users/x/proj", isDirectory: true)
        XCTAssertEqual(ExplorerPaths.includeGlob(
            for: root.appendingPathComponent("app/job", isDirectory: true), root: root), "app/job/")
        XCTAssertEqual(ExplorerPaths.includeGlob(for: root, root: root), "",
                       "the root itself means search everything")
        XCTAssertNil(ExplorerPaths.includeGlob(
            for: URL(fileURLWithPath: "/Users/x/elsewhere", isDirectory: true), root: root),
                     "a folder outside Search's root disables the menu item")
        XCTAssertEqual(ExplorerPaths.includeGlob(
            for: root.appendingPathComponent("設計", isDirectory: true), root: root), "設計/")
    }
}

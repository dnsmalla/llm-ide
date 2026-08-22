import XCTest
@testable import LlmIdeMacLib

/// The Library sidebar and the detail pane are siblings under AppShell, so a
/// mutation made in the detail (consent, enable, remove) cannot call back into
/// the list directly. It bumps a token on the shared ShellState instead, and
/// the sidebar reloads when the token changes — otherwise a server the user
/// just consented to keeps showing its old state until a full Library reload.
final class LibraryRefreshTokenTests: XCTestCase {
    @MainActor
    func testTokenStartsAtZeroAndAdvances() {
        let shell = ShellState()
        XCTAssertEqual(shell.libraryDirtyToken, 0)
        shell.markLibraryDirty()
        XCTAssertEqual(shell.libraryDirtyToken, 1)
        shell.markLibraryDirty()
        XCTAssertEqual(shell.libraryDirtyToken, 2)
    }

    @MainActor
    func testTokenIsMonotonicSoRepeatedMutationsAlwaysTrigger() {
        let shell = ShellState()
        var seen = Set<Int>()
        for _ in 0..<5 {
            shell.markLibraryDirty()
            XCTAssertFalse(seen.contains(shell.libraryDirtyToken), "a repeated value would be a missed refresh")
            seen.insert(shell.libraryDirtyToken)
        }
    }
}

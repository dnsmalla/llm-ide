import XCTest
import SwiftUI
@testable import LlmIdeMacLib

final class ExplorerKeyCommandTests: XCTestCase {

    func testArrowKeysExpandAndCollapse() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\u{F703}", command: false), .expand)
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\u{F702}", command: false), .collapse)
    }

    func testReturnOpens() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\r", command: false), .open)
    }

    /// F2 is the macOS/VS Code rename key. It has to be claimed here, not in a
    /// `.keyboardShortcut`, because the tree's rows are not buttons any more.
    func testF2Renames() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\u{F705}", command: false), .rename)
    }

    /// ↑/↓ belong to `List` — claiming them would break its own selection
    /// movement and ⇧-extend.
    func testVerticalArrowsAreNotClaimed() {
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F700}", command: false))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F701}", command: false))
    }

    func testUnknownKeysAreNotClaimed() {
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "a", command: false))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: " ", command: false))
    }

    /// ⌘→ / ⌘← are macOS text-navigation chords, not tree navigation — a
    /// command-modified arrow must not silently expand a folder.
    func testCommandModifiedArrowsAreNotClaimed() {
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F703}", command: true))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F702}", command: true))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\r", command: true))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "\u{F705}", command: true))
    }

    func testCommandXCVAreCutCopyPaste() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "x", command: true), .cut)
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "c", command: true), .copy)
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "v", command: true), .paste)
    }

    func testCommandLettersAreCaseInsensitive() {
        // ⇧⌘C reports an uppercase character; it must still mean copy rather
        // than falling through as an unhandled key.
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "X", command: true), .cut)
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "C", command: true), .copy)
    }

    func testBareLettersAreNotClipboardCommands() {
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "x", command: false))
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "v", command: false))
    }

    /// The clipboard branch must not swallow the non-command bindings F2 and
    /// ⏎ still own — adding ⌘X/⌘C/⌘V is a pure addition, not a takeover.
    func testCommandBranchDoesNotEatTheOtherBindings() {
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\u{F705}", command: false), .rename)
        XCTAssertEqual(ExplorerKeyCommand.resolve(character: "\r", command: false), .open)
        XCTAssertNil(ExplorerKeyCommand.resolve(character: "z", command: true))
    }

    /// Pins the scalars against SwiftUI's own constants, so a wrong literal
    /// here fails the test rather than silently making the arrow keys dead.
    func testScalarsMatchSwiftUIKeyEquivalents() {
        XCTAssertEqual(ExplorerKeyCommand.rightArrow, KeyEquivalent.rightArrow.character)
        XCTAssertEqual(ExplorerKeyCommand.leftArrow, KeyEquivalent.leftArrow.character)
        XCTAssertEqual(ExplorerKeyCommand.returnKey, KeyEquivalent.return.character)
    }

    /// SwiftUI has no `KeyEquivalent.f2`, so this scalar cannot be pinned the
    /// way the arrows are above — it is pinned against `NSF2FunctionKey`'s
    /// documented value instead. A wrong literal would show up only as a dead
    /// rename key in the running app.
    func testF2ScalarIsTheAppKitFunctionKey() {
        XCTAssertEqual(ExplorerKeyCommand.f2, "\u{F705}")
        XCTAssertEqual(ExplorerKeyCommand.f2.unicodeScalars.first?.value, 0xF705)
    }
}

/// Inline rename's name rule. The interesting case is the interior newline:
/// `ExplorerFileOps.validate` trims leading/trailing newlines and would let
/// "a⏎b" through to `moveItem`.
final class ExplorerRenameNameTests: XCTestCase {

    func testUnchangedNameCancels() {
        XCTAssertEqual(ExplorerRenameName.resolve("a.txt", current: "a.txt"), .cancel)
    }

    func testEmptyOrWhitespaceNameCancels() {
        XCTAssertEqual(ExplorerRenameName.resolve("", current: "a.txt"), .cancel)
        XCTAssertEqual(ExplorerRenameName.resolve("   ", current: "a.txt"), .cancel)
    }

    func testSurroundingWhitespaceIsTrimmedNotRejected() {
        XCTAssertEqual(ExplorerRenameName.resolve("  b.txt \n", current: "a.txt"),
                       .apply("b.txt"))
    }

    /// Trimming must not turn a merely-padded version of the SAME name into a
    /// rename onto itself.
    func testPaddedUnchangedNameStillCancels() {
        XCTAssertEqual(ExplorerRenameName.resolve("  a.txt  ", current: "a.txt"), .cancel)
    }

    func testInteriorNewlineIsRejected() {
        XCTAssertEqual(ExplorerRenameName.resolve("a\nb.txt", current: "a.txt"),
                       .reject(.invalidName))
        // "\r\n" is ONE Swift Character; a `contains("\n")` check misses it.
        XCTAssertEqual(ExplorerRenameName.resolve("a\r\nb.txt", current: "a.txt"),
                       .reject(.invalidName))
        XCTAssertEqual(ExplorerRenameName.resolve("a\rb.txt", current: "a.txt"),
                       .reject(.invalidName))
        XCTAssertEqual(ExplorerRenameName.resolve("a\u{2028}b.txt", current: "a.txt"),
                       .reject(.invalidName))
    }

    /// "/" and "." / ".." stay owned by `ExplorerFileOps.validate` — ONE
    /// definition of a valid name, applied by the code that acts on it — so
    /// they arrive here as `.apply` and are refused when the rename runs.
    func testSlashIsLeftToTheFileOpToRefuse() {
        XCTAssertEqual(ExplorerRenameName.resolve("a/b.txt", current: "a.txt"),
                       .apply("a/b.txt"))
        XCTAssertThrowsError(try ExplorerFileOps.rename(
            URL(fileURLWithPath: "/tmp/does-not-exist/a.txt"), to: "a/b.txt")) { error in
            XCTAssertEqual(error as? ExplorerFileError, .invalidName)
        }
    }

    /// This project's users work in Japanese; a multi-byte name must round-trip
    /// unchanged rather than being mangled by the trim.
    func testJapaneseNameRoundTrips() {
        XCTAssertEqual(ExplorerRenameName.resolve("設計 v2.txt", current: "設計.txt"),
                       .apply("設計 v2.txt"))
    }
}

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
}

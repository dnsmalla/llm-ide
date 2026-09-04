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
///
/// FIXTURE HAZARD — the temp fixtures below live under `/var/folders`, which is
/// exactly where `ExplorerPaths.key(_:)` is existence-dependent: Foundation
/// folds `/private` only while a path EXISTS, so the same path keys differently
/// once it is deleted. A deleted-path assertion that behaves oddly here is the
/// FIXTURE, not the code — re-root under `$HOME` rather than chasing it. Latent
/// today: no XCTest has ever executed in this repo.
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

    /// `.nameHasLineBreak`, not `.invalidName`: the latter's sentence names "/"
    /// and "." and would send the user hunting for a slash that isn't there.
    func testInteriorNewlineIsRejected() {
        XCTAssertEqual(ExplorerRenameName.resolve("a\nb.txt", current: "a.txt"),
                       .reject(.nameHasLineBreak))
        // "\r\n" is ONE Swift Character; a `contains("\n")` check misses it.
        XCTAssertEqual(ExplorerRenameName.resolve("a\r\nb.txt", current: "a.txt"),
                       .reject(.nameHasLineBreak))
        XCTAssertEqual(ExplorerRenameName.resolve("a\rb.txt", current: "a.txt"),
                       .reject(.nameHasLineBreak))
        XCTAssertEqual(ExplorerRenameName.resolve("a\u{2028}b.txt", current: "a.txt"),
                       .reject(.nameHasLineBreak))
        XCTAssertEqual(ExplorerFileError.nameHasLineBreak.errorDescription,
                       "Names can't contain line breaks.")
    }

    /// The sheets (New File / New Folder) reach `validate` directly — no
    /// `ExplorerRenameName` in front of them — so the same rule must hold
    /// there, with the same message.
    func testSheetCreatePathRejectsInteriorNewline() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("explorer-newline-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        XCTAssertThrowsError(try ExplorerFileOps.createFile(in: dir, name: "x\ny.txt")) { error in
            XCTAssertEqual(error as? ExplorerFileError, .nameHasLineBreak)
        }
        XCTAssertThrowsError(try ExplorerFileOps.createFolder(in: dir, name: "x\r\ny")) { error in
            XCTAssertEqual(error as? ExplorerFileError, .nameHasLineBreak)
        }
        // A space is not a line break, and a Japanese name must still pass.
        XCTAssertNoThrow(try ExplorerFileOps.createFile(in: dir, name: "x y.txt"))
        XCTAssertNoThrow(try ExplorerFileOps.createFile(in: dir, name: "設計.txt"))
    }

    /// A case-only rename on a case-insensitive volume (the macOS/APFS default)
    /// must succeed, not report "An item with this name already exists." —
    /// the source and the destination are the same directory entry there.
    func testCaseOnlyRenameSucceeds() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("explorer-case-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let source = dir.appendingPathComponent("Foo.swift")
        try "hello".write(to: source, atomically: true, encoding: .utf8)

        let renamed = try ExplorerFileOps.rename(source, to: "foo.swift")
        XCTAssertEqual(renamed.lastPathComponent, "foo.swift")
        XCTAssertEqual(try String(contentsOf: renamed, encoding: .utf8), "hello")
        // Exactly one entry, spelled the new way, and no staging file left over.
        let listed = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertEqual(listed, ["foo.swift"])
    }

    /// The case-only path must not become a way to clobber a DIFFERENT file
    /// that happens to differ only in case from the requested name.
    func testRenameOntoADifferentlyCasedSiblingIsStillRefused() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("explorer-case2-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let source = dir.appendingPathComponent("Foo.swift")
        try "source".write(to: source, atomically: true, encoding: .utf8)
        let victim = dir.appendingPathComponent("bar.swift")
        try "victim".write(to: victim, atomically: true, encoding: .utf8)

        XCTAssertThrowsError(try ExplorerFileOps.rename(source, to: "Bar.swift")) { error in
            XCTAssertEqual(error as? ExplorerFileError, .alreadyExists)
        }
        XCTAssertEqual(try String(contentsOf: victim, encoding: .utf8), "victim")
        XCTAssertEqual(try String(contentsOf: source, encoding: .utf8), "source")
    }

    /// `realWorldKey` resolves symlinks on BOTH sides, so it reports "same
    /// place" for two DISTINCT entries that alias one target. Those must not
    /// reach the case-only two-step, which would fail on its second move and
    /// surface a raw Cocoa sentence quoting the internal staging UUID. The
    /// case-folded leaf comparison in the guard is what keeps them out.
    func testSymlinkAliasesAreRefusedNotRoutedThroughTheCaseRename() throws {
        let fm = FileManager.default
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("explorer-alias-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }

        // A symlink renamed onto its OWN target.
        let target = dir.appendingPathComponent("real.txt")
        try "victim".write(to: target, atomically: true, encoding: .utf8)
        try fm.createSymbolicLink(atPath: dir.appendingPathComponent("Link.txt").path,
                                  withDestinationPath: "real.txt")
        XCTAssertThrowsError(
            try ExplorerFileOps.rename(dir.appendingPathComponent("Link.txt"), to: "real.txt")
        ) { error in
            XCTAssertEqual(error as? ExplorerFileError, .alreadyExists)
        }
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "victim")

        // A CASE-only rename of that same symlink still succeeds — the guard
        // must not have been tightened into refusing symlinks outright.
        let renamed = try ExplorerFileOps.rename(dir.appendingPathComponent("Link.txt"), to: "link.txt")
        XCTAssertEqual(renamed.lastPathComponent, "link.txt")

        // No hidden staging file survived either operation.
        let listed = try fm.contentsOfDirectory(atPath: dir.path).sorted()
        XCTAssertEqual(listed, ["link.txt", "real.txt"])
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

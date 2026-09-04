import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ExplorerClipboardTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-clip-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    // MARK: - clipboard state

    func testNewClipboardIsEmpty() {
        let clip = ExplorerClipboard()
        XCTAssertTrue(clip.isEmpty)
        XCTAssertNil(clip.operation)
        XCTAssertTrue(clip.urls.isEmpty)
    }

    func testCutRecordsUrlsAndOperation() {
        let clip = ExplorerClipboard()
        clip.cut([URL(fileURLWithPath: "/tmp/a"), URL(fileURLWithPath: "/tmp/b")])
        XCTAssertEqual(clip.operation, .cut)
        XCTAssertEqual(clip.urls.map(\.path), ["/tmp/a", "/tmp/b"])
        XCTAssertFalse(clip.isEmpty)
    }

    func testCopyReplacesAPreviousCut() {
        let clip = ExplorerClipboard()
        clip.cut([URL(fileURLWithPath: "/tmp/a")])
        clip.copy([URL(fileURLWithPath: "/tmp/b")])
        XCTAssertEqual(clip.operation, .copy)
        XCTAssertEqual(clip.urls.map(\.path), ["/tmp/b"])
    }

    func testCuttingNothingClearsTheClipboard() {
        let clip = ExplorerClipboard()
        clip.copy([URL(fileURLWithPath: "/tmp/a")])
        clip.cut([])
        XCTAssertTrue(clip.isEmpty)
        XCTAssertNil(clip.operation)
    }

    func testClearEmptiesEverything() {
        let clip = ExplorerClipboard()
        clip.copy([URL(fileURLWithPath: "/tmp/a")])
        clip.clear()
        XCTAssertTrue(clip.isEmpty)
        XCTAssertNil(clip.operation)
    }

    // MARK: - ExplorerFileOps.paste (real filesystem)

    func testPasteWithMoveRelocatesEveryItem() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let b = try ExplorerFileOps.createFile(in: root, name: "b.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "dest")

        let results = try ExplorerFileOps.paste([a, b], into: dest, move: true)

        XCTAssertEqual(results.map(\.lastPathComponent), ["a.txt", "b.txt"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: a.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.appendingPathComponent("b.txt").path))
    }

    func testPasteWithCopyLeavesSourcesInPlace() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "dest")

        let results = try ExplorerFileOps.paste([a], into: dest, move: false)

        XCTAssertTrue(FileManager.default.fileExists(atPath: a.path))
        XCTAssertEqual(results.map(\.lastPathComponent), ["a.txt"])
    }

    func testPasteCopyIntoTheSameFolderUniquifies() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let results = try ExplorerFileOps.paste([a], into: root, move: false)
        XCTAssertEqual(results.map(\.lastPathComponent), ["a copy.txt"])
    }

    /// Pasting a copy twice is Finder's repeat-paste: two distinct siblings,
    /// never one silently overwritten.
    func testPastingTheSameCopyTwiceProducesTwoDistinctItems() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let first = try ExplorerFileOps.paste([a], into: root, move: false)
        let second = try ExplorerFileOps.paste([a], into: root, move: false)
        XCTAssertEqual(first.map(\.lastPathComponent), ["a copy.txt"])
        XCTAssertEqual(second.map(\.lastPathComponent), ["a copy 2.txt"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: a.path))
    }

    func testPasteMoveIntoTheSameFolderIsANoOp() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let results = try ExplorerFileOps.paste([a], into: root, move: true)
        XCTAssertEqual(results.map(\.path), [a.path])
        XCTAssertTrue(FileManager.default.fileExists(atPath: a.path))
    }

    func testPasteMoveOntoAnExistingNameThrowsWithoutOverwriting() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        try "source".write(to: a, atomically: true, encoding: .utf8)
        let dest = try ExplorerFileOps.createFolder(in: root, name: "dest")
        let clash = try ExplorerFileOps.createFile(in: dest, name: "a.txt")
        try "victim".write(to: clash, atomically: true, encoding: .utf8)

        XCTAssertThrowsError(try ExplorerFileOps.paste([a], into: dest, move: true)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .alreadyExists)
        }
        XCTAssertEqual(try String(contentsOf: clash, encoding: .utf8), "victim",
                       "paste must never overwrite an existing file")
    }

    /// Pasting a cut folder into its own descendant is caught by
    /// `ExplorerFileOps`'s own self-nesting guard — `paste` composes `move`
    /// and adds NO second containment check of its own.
    func testPasteOfAFolderIntoItsOwnDescendantIsRefused() throws {
        let outer = try ExplorerFileOps.createFolder(in: root, name: "outer")
        let inner = try ExplorerFileOps.createFolder(in: outer, name: "inner")

        XCTAssertThrowsError(try ExplorerFileOps.paste([outer], into: inner, move: true)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .cannotMoveIntoSelf)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: inner.path),
                      "the tree must be untouched after a refused paste")
    }

    /// This project's users work in Japanese; a non-ASCII name must survive a
    /// paste, including the Finder-style uniquifier.
    func testPasteHandlesJapaneseNames() throws {
        let jp = try ExplorerFileOps.createFile(in: root, name: "設計.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "資料 フォルダ")

        let moved = try ExplorerFileOps.paste([jp], into: dest, move: true)
        XCTAssertEqual(moved.map(\.lastPathComponent), ["設計.txt"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: jp.path))

        let copied = try ExplorerFileOps.paste(moved, into: dest, move: false)
        XCTAssertEqual(copied.map(\.lastPathComponent), ["設計 copy.txt"])
    }

    func testPasteOfNothingIsAnEmptyResult() throws {
        XCTAssertTrue(try ExplorerFileOps.paste([], into: root, move: true).isEmpty)
    }

    // MARK: - a source that vanished between the cut and the paste

    /// One stale clipboard entry must not block the valid items behind it. If
    /// it did, the paste would fail, so the clipboard would never be consumed,
    /// so the next ⌘V would fail identically — wedged until the user
    /// re-selects.
    func testPasteSkipsAVanishedSourceAndStillMovesTheRest() throws {
        let a = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let b = try ExplorerFileOps.createFile(in: root, name: "b.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "dest")
        try FileManager.default.removeItem(at: a)

        let results = try ExplorerFileOps.paste([a, b], into: dest, move: true)

        XCTAssertEqual(results.map(\.lastPathComponent), ["b.txt"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.appendingPathComponent("b.txt").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: b.path))
    }

    /// When NOTHING could be applied — the single-item case — silently doing
    /// nothing would look like a broken ⌘V, so the throw names the item.
    func testPasteOfOnlyVanishedSourcesThrowsNamingTheItem() throws {
        let gone = root.appendingPathComponent("gone.txt")
        XCTAssertThrowsError(try ExplorerFileOps.paste([gone], into: root, move: true)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .sourceMissing("gone.txt"))
        }
    }

    /// A direct `move`/`copy` of a vanished source reports a typed error, not
    /// `FileManager`'s raw "…either the former doesn't exist, or the folder
    /// containing the latter doesn't exist" sentence.
    func testMoveAndCopyOfAVanishedSourceReportATypedError() throws {
        let gone = root.appendingPathComponent("gone.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "dest")
        XCTAssertThrowsError(try ExplorerFileOps.move(from: gone, to: dest)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .sourceMissing("gone.txt"))
        }
        XCTAssertThrowsError(try ExplorerFileOps.copy(from: gone, to: dest)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .sourceMissing("gone.txt"))
        }
    }

    /// A BROKEN symlink is a real item the user can see and is entitled to
    /// move — `fileExists(atPath:)` follows links and would call it vanished,
    /// which is why the check lstats instead.
    func testABrokenSymlinkIsNotTreatedAsVanished() throws {
        let link = root.appendingPathComponent("link.txt")
        try FileManager.default.createSymbolicLink(
            at: link, withDestinationURL: root.appendingPathComponent("nothing-here.txt"))
        let dest = try ExplorerFileOps.createFolder(in: root, name: "dest")

        let results = try ExplorerFileOps.paste([link], into: dest, move: true)

        XCTAssertEqual(results.map(\.lastPathComponent), ["link.txt"])
        XCTAssertTrue(ExplorerFileOps.itemExists(dest.appendingPathComponent("link.txt")))
    }
}

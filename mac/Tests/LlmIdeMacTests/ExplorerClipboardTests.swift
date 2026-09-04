import XCTest
@testable import LlmIdeMacLib

/// FIXTURE HAZARD — the temp fixtures below live under `/var/folders`, which is
/// exactly where `ExplorerPaths.key(_:)` is existence-dependent: Foundation
/// folds `/private` only while a path EXISTS, so the same path keys differently
/// once it is deleted. A deleted-path assertion that behaves oddly here is the
/// FIXTURE, not the code — re-root under `$HOME` rather than chasing it. Latent
/// today: no XCTest has ever executed in this repo.
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

    // MARK: - what a paste is made of (real filesystem)
    //
    // `ExplorerFileOps` has no batch paste helper any more, and these no
    // longer pretend it does. A paste is `ExplorerView.performPaste` over
    // `move`/`copy` per item, because only the view can remap the open tabs
    // and the selection for each item as it lands. What is left here is the
    // per-item behaviour that loop depends on; the collision, self-nesting and
    // uniquifier rules live in `ExplorerFileOpsTests`.

    /// This project's users work in Japanese; a non-ASCII name (and a
    /// destination with a space in it) must survive both halves of a paste,
    /// including the Finder-style uniquifier.
    func testMoveAndCopyHandleJapaneseNames() throws {
        let jp = try ExplorerFileOps.createFile(in: root, name: "設計.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "資料 フォルダ")

        let moved = try ExplorerFileOps.move(from: jp, to: dest)
        XCTAssertEqual(moved.lastPathComponent, "設計.txt")
        XCTAssertFalse(FileManager.default.fileExists(atPath: jp.path))

        let copied = try ExplorerFileOps.copy(from: moved, to: dest)
        XCTAssertEqual(copied.lastPathComponent, "設計 copy.txt")
    }

    // MARK: - a source that vanished between the cut and the paste

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

        XCTAssertTrue(ExplorerFileOps.itemExists(link))
        let moved = try ExplorerFileOps.move(from: link, to: dest)

        XCTAssertEqual(moved.lastPathComponent, "link.txt")
        XCTAssertTrue(ExplorerFileOps.itemExists(dest.appendingPathComponent("link.txt")))
    }
}

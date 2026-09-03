import XCTest
@testable import LlmIdeMacLib

final class ExplorerFileOpsTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-ops-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    func testCreateFileMakesEmptyFile() throws {
        let url = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertEqual((try? String(contentsOf: url, encoding: .utf8)) ?? "x", "")
    }

    func testCreateFolderMakesDirectory() throws {
        let url = try ExplorerFileOps.createFolder(in: root, name: "sub")
        var isDir: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir))
        XCTAssertTrue(isDir.boolValue)
    }

    func testDuplicateNameThrowsAlreadyExists() throws {
        _ = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        XCTAssertThrowsError(try ExplorerFileOps.createFile(in: root, name: "a.txt")) { err in
            XCTAssertEqual(err as? ExplorerFileError, .alreadyExists)
        }
    }

    func testEmptyNameThrowsEmptyName() {
        XCTAssertThrowsError(try ExplorerFileOps.createFile(in: root, name: "   ")) { err in
            XCTAssertEqual(err as? ExplorerFileError, .emptyName)
        }
    }

    func testRenameMovesAndReturnsNewURL() throws {
        let old = try ExplorerFileOps.createFile(in: root, name: "old.txt")
        let new = try ExplorerFileOps.rename(old, to: "new.txt")
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: new.path))
        XCTAssertEqual(new.lastPathComponent, "new.txt")
    }

    func testTrashRemovesItem() throws {
        let url = try ExplorerFileOps.createFile(in: root, name: "gone.txt")
        try ExplorerFileOps.trash(url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    // MARK: - move

    func testMoveRelocatesIntoDestinationDirectory() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "sub")
        let moved = try ExplorerFileOps.move(from: src, to: dest)
        XCTAssertFalse(FileManager.default.fileExists(atPath: src.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: moved.path))
        XCTAssertEqual(moved.path, dest.appendingPathComponent("a.txt").path)
    }

    func testMoveNeverOverwritesAnExistingItem() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let dest = try ExplorerFileOps.createFolder(in: root, name: "sub")
        _ = try ExplorerFileOps.createFile(in: dest, name: "a.txt")
        XCTAssertThrowsError(try ExplorerFileOps.move(from: src, to: dest)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .alreadyExists)
        }
        // The source must survive a rejected move.
        XCTAssertTrue(FileManager.default.fileExists(atPath: src.path))
    }

    func testMoveIntoItsOwnParentIsANoOp() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let result = try ExplorerFileOps.move(from: src, to: root)
        XCTAssertEqual(result.path, src.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: src.path))
    }

    func testMoveFolderIntoItselfThrows() throws {
        let folder = try ExplorerFileOps.createFolder(in: root, name: "parent")
        XCTAssertThrowsError(try ExplorerFileOps.move(from: folder, to: folder)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .cannotMoveIntoSelf)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.path))
    }

    func testMoveFolderIntoItsOwnDescendantThrows() throws {
        let parent = try ExplorerFileOps.createFolder(in: root, name: "parent")
        let child = try ExplorerFileOps.createFolder(in: parent, name: "child")
        XCTAssertThrowsError(try ExplorerFileOps.move(from: parent, to: child)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .cannotMoveIntoSelf)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: child.path),
                      "a rejected self-nesting move must not have disturbed the tree")
    }

    // MARK: - uniqueDestination

    func testUniqueDestinationReturnsTheNameWhenFree() {
        let url = ExplorerFileOps.uniqueDestination(in: root, name: "a.txt")
        XCTAssertEqual(url.lastPathComponent, "a.txt")
    }

    func testUniqueDestinationAppendsFinderStyleCopySuffixes() throws {
        _ = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        XCTAssertEqual(ExplorerFileOps.uniqueDestination(in: root, name: "a.txt").lastPathComponent,
                       "a copy.txt")
        _ = try ExplorerFileOps.createFile(in: root, name: "a copy.txt")
        XCTAssertEqual(ExplorerFileOps.uniqueDestination(in: root, name: "a.txt").lastPathComponent,
                       "a copy 2.txt")
    }

    func testUniqueDestinationHandlesExtensionlessNames() throws {
        _ = try ExplorerFileOps.createFolder(in: root, name: "docs")
        XCTAssertEqual(ExplorerFileOps.uniqueDestination(in: root, name: "docs").lastPathComponent,
                       "docs copy")
    }

    // MARK: - copy

    func testCopyDuplicatesFileAndLeavesSourceInPlace() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        try "hello".write(to: src, atomically: true, encoding: .utf8)
        let dest = try ExplorerFileOps.createFolder(in: root, name: "sub")
        let copied = try ExplorerFileOps.copy(from: src, to: dest)
        XCTAssertTrue(FileManager.default.fileExists(atPath: src.path))
        XCTAssertEqual(try String(contentsOf: copied, encoding: .utf8), "hello")
        XCTAssertEqual(copied.lastPathComponent, "a.txt")
    }

    func testCopyIntoTheSameDirectoryAutoUniquifies() throws {
        let src = try ExplorerFileOps.createFile(in: root, name: "a.txt")
        let copied = try ExplorerFileOps.copy(from: src, to: root)
        XCTAssertEqual(copied.lastPathComponent, "a copy.txt")
        XCTAssertTrue(FileManager.default.fileExists(atPath: src.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: copied.path))
    }

    func testCopyFolderIntoItsOwnDescendantThrows() throws {
        let parent = try ExplorerFileOps.createFolder(in: root, name: "parent")
        let child = try ExplorerFileOps.createFolder(in: parent, name: "child")
        XCTAssertThrowsError(try ExplorerFileOps.copy(from: parent, to: child)) { err in
            XCTAssertEqual(err as? ExplorerFileError, .cannotMoveIntoSelf)
        }
    }
}

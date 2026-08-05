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
}

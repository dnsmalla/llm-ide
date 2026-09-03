import XCTest
@testable import LlmIdeMacLib

final class ExplorerPathsTests: XCTestCase {

    // MARK: - key

    func testKeyStandardizesAndDropsTrailingSlash() {
        let a = URL(fileURLWithPath: "/tmp/a/b/", isDirectory: true)
        let b = URL(fileURLWithPath: "/tmp/a/./b")
        XCTAssertEqual(ExplorerPaths.key(a), ExplorerPaths.key(b))
        XCTAssertFalse(ExplorerPaths.key(a).hasSuffix("/"))
    }

    // MARK: - relativePath

    func testRelativePathOfDescendant() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        let file = URL(fileURLWithPath: "/tmp/proj/src/main.swift")
        XCTAssertEqual(ExplorerPaths.relativePath(of: file, from: root), "src/main.swift")
    }

    func testRelativePathOfRootItselfIsEmptyString() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertEqual(ExplorerPaths.relativePath(of: root, from: root), "")
    }

    func testRelativePathOutsideRootIsNil() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertNil(ExplorerPaths.relativePath(of: URL(fileURLWithPath: "/tmp/other/x"), from: root))
    }

    /// The sibling-prefix trap: "/tmp/projector" starts with "/tmp/proj" as a
    /// STRING but is not inside it. A naive `hasPrefix(root.path)` would move
    /// files into the wrong tree.
    func testRelativePathRejectsSiblingWithSharedPrefix() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertNil(ExplorerPaths.relativePath(of: URL(fileURLWithPath: "/tmp/projector/x"), from: root))
    }

    // MARK: - isDescendant

    func testIsDescendantIsStrict() {
        let dir = URL(fileURLWithPath: "/tmp/proj/src")
        XCTAssertTrue(ExplorerPaths.isDescendant(URL(fileURLWithPath: "/tmp/proj/src/a.swift"), of: dir))
        XCTAssertTrue(ExplorerPaths.isDescendant(URL(fileURLWithPath: "/tmp/proj/src/deep/a.swift"), of: dir))
        XCTAssertFalse(ExplorerPaths.isDescendant(dir, of: dir), "a directory is not its own descendant")
        XCTAssertFalse(ExplorerPaths.isDescendant(URL(fileURLWithPath: "/tmp/proj/srcx/a.swift"), of: dir))
        XCTAssertFalse(ExplorerPaths.isDescendant(URL(fileURLWithPath: "/tmp/proj"), of: dir))
    }

    // MARK: - includeGlob

    func testIncludeGlobForNestedFolderIsPrefixWithTrailingSlash() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertEqual(
            ExplorerPaths.includeGlob(for: URL(fileURLWithPath: "/tmp/proj/app/job"), root: root),
            "app/job/")
    }

    func testIncludeGlobForRootItselfIsEmptyMeaningEverything() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertEqual(ExplorerPaths.includeGlob(for: root, root: root), "")
    }

    func testIncludeGlobOutsideRootIsNil() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        XCTAssertNil(ExplorerPaths.includeGlob(for: URL(fileURLWithPath: "/tmp/elsewhere"), root: root))
    }
}

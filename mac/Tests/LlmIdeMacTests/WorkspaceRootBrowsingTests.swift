import XCTest
@testable import LlmIdeMacLib

/// `pickBrowsingRoot` is the ONE definition of "the folder the code-browsing
/// panels show", shared by Explorer and Search. Its `exists` parameter is
/// load-bearing: a brand-new project has a `code/` path that does not exist
/// yet, and without the check Search would silently root at a missing folder
/// and report zero results forever.
final class WorkspaceRootBrowsingTests: XCTestCase {

    private func dir(_ path: String) -> URL { URL(fileURLWithPath: path) }

    private func node(_ path: String, isDirectory: Bool) -> FileSystemTree.Node {
        FileSystemTree.Node(url: dir(path),
                            name: dir(path).lastPathComponent,
                            isDirectory: isDirectory)
    }

    func testPrefersTheProjectCodeDirWhenItExists() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: dir("/repo"),
            exists: { _ in true },
            children: { _ in [self.node("/p/code/a.txt", isDirectory: false),
                              self.node("/p/code/b.txt", isDirectory: false)] })
        XCTAssertEqual(root, dir("/p/code"))
    }

    func testFallsBackWhenTheCodeDirDoesNotExistYet() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: dir("/repo"),
            exists: { $0.path == "/repo" },
            children: { _ in [] })
        XCTAssertEqual(root, dir("/repo"))
    }

    func testFallsBackWhenThereIsNoProject() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: nil,
            fallback: dir("/repo"),
            exists: { _ in true },
            children: { _ in [] })
        XCTAssertEqual(root, dir("/repo"))
    }

    func testNilWhenNeitherIsUsable() {
        XCTAssertNil(WorkspaceRoot.pickBrowsingRoot(
            codeDir: nil, fallback: nil, exists: { _ in true }, children: { _ in [] }))
        XCTAssertNil(WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"), fallback: nil,
            exists: { _ in false }, children: { _ in [] }))
    }

    func testCollapsesIntoASingleChildDirectory() {
        // The Explorer's display behaviour: `code/` holding exactly one clone
        // shows that clone as the tree root, not a one-item wrapper.
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: nil,
            exists: { _ in true },
            children: { _ in [self.node("/p/code/my-repo", isDirectory: true)] })
        XCTAssertEqual(root, dir("/p/code/my-repo"))
    }

    func testDoesNotCollapseIntoASingleFile() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: nil,
            exists: { _ in true },
            children: { _ in [self.node("/p/code/README.md", isDirectory: false)] })
        XCTAssertEqual(root, dir("/p/code"))
    }

    func testDoesNotCollapseWithTwoChildren() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: nil,
            exists: { _ in true },
            children: { _ in [self.node("/p/code/one", isDirectory: true),
                              self.node("/p/code/two", isDirectory: true)] })
        XCTAssertEqual(root, dir("/p/code"))
    }

    func testCollapsesOnlyOneLevel() {
        // Deliberate: matches ExplorerTreeStore.displayRoot(for:), which reads
        // ONE directory's children. Deeper collapsing would cost an extra
        // filesystem read per project switch for no user-visible gain.
        var calls = 0
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: nil,
            exists: { _ in true },
            children: { _ in
                calls += 1
                return [self.node("/p/code/only", isDirectory: true)]
            })
        XCTAssertEqual(root, dir("/p/code/only"))
        XCTAssertEqual(calls, 1)
    }

    /// Non-ASCII and spaced folder names are first-class: this app's users work
    /// in Japanese, and the collapse returns the child URL verbatim.
    func testCollapsesIntoANonASCIIChildDirectory() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: nil,
            exists: { _ in true },
            children: { _ in [self.node("/p/code/設計 repo", isDirectory: true)] })
        XCTAssertEqual(root, dir("/p/code/設計 repo"))
    }
}

import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ExplorerTreeStoreTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-tree-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    @discardableResult
    private func makeDir(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @discardableResult
    private func makeFile(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: Data())
        return url
    }

    // MARK: - children cache

    func testChildrenIsEmptyBeforeLoadAndPopulatedAfter() async {
        makeFile("a.txt")
        let store = ExplorerTreeStore()
        XCTAssertTrue(store.children(of: root).isEmpty, "reading the cache must not hit the filesystem")
        XCTAssertFalse(store.isLoaded(root))

        await store.loadChildren(of: root)

        XCTAssertTrue(store.isLoaded(root))
        XCTAssertEqual(store.children(of: root).map(\.name), ["a.txt"])
    }

    func testChildrenAreDirectoriesFirstThenCaseInsensitiveByName() async {
        makeFile("Zebra.txt")
        makeFile("apple.txt")
        makeDir("src")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertEqual(store.children(of: root).map(\.name), ["src", "apple.txt", "Zebra.txt"])
    }

    func testInvalidateDropsOnlyThatDirectorysCache() async {
        makeFile("a.txt")
        let sub = makeDir("sub")
        makeFile("sub/b.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.loadChildren(of: sub)

        store.invalidate(sub)

        XCTAssertTrue(store.isLoaded(root))
        XCTAssertFalse(store.isLoaded(sub))
    }

    func testReloadingAfterAFilesystemChangePicksUpTheNewFile() async {
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertTrue(store.children(of: root).isEmpty)

        makeFile("late.txt")
        await store.loadChildren(of: root)

        XCTAssertEqual(store.children(of: root).map(\.name), ["late.txt"])
    }

    /// A trailing-slash directory URL and a plain one are the SAME directory —
    /// two cache entries here would double-load the tree and desync expansion.
    func testCacheKeyIgnoresTrailingSlash() async {
        makeFile("a.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        let withSlash = URL(fileURLWithPath: root.path + "/", isDirectory: true)
        XCTAssertTrue(store.isLoaded(withSlash))
        XCTAssertEqual(store.children(of: withSlash).map(\.name), ["a.txt"])
    }

    /// This project's users work in Japanese, and P2 found two independent
    /// non-ASCII path bugs. A name that is not NFC-stable on disk must still
    /// round-trip through `ExplorerPaths.key` into the same cache entry.
    func testNonASCIIAndSpacedNamesLoadAndKeyConsistently() async {
        makeFile("設計.txt")
        let folder = makeDir("my docs")
        makeFile("my docs/メモ 1.md")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.loadChildren(of: folder)

        XCTAssertEqual(store.children(of: root).map(\.name), ["my docs", "設計.txt"])
        XCTAssertEqual(store.children(of: folder).map(\.name), ["メモ 1.md"])
        XCTAssertTrue(store.isLoaded(root.appendingPathComponent("my docs")))
    }

    // MARK: - expansion

    func testExpandLoadsChildrenAndCollapseKeepsThemCached() async {
        let sub = makeDir("sub")
        makeFile("sub/b.txt")
        let store = ExplorerTreeStore()

        await store.expand(sub)
        XCTAssertTrue(store.expanded.contains(ExplorerPaths.key(sub)))
        XCTAssertEqual(store.children(of: sub).map(\.name), ["b.txt"])

        store.collapse(sub)
        XCTAssertFalse(store.expanded.contains(ExplorerPaths.key(sub)))
        XCTAssertTrue(store.isLoaded(sub), "collapsing must not discard the cache")
    }

    func testToggleFlipsExpansion() async {
        let sub = makeDir("sub")
        let store = ExplorerTreeStore()
        await store.toggle(sub)
        XCTAssertTrue(store.expanded.contains(ExplorerPaths.key(sub)))
        await store.toggle(sub)
        XCTAssertFalse(store.expanded.contains(ExplorerPaths.key(sub)))
    }

    func testCollapseAllClearsExpansionButNotTheCache() async {
        let a = makeDir("a")
        let b = makeDir("b")
        let store = ExplorerTreeStore()
        await store.expand(a)
        await store.expand(b)

        store.collapseAll()

        XCTAssertTrue(store.expanded.isEmpty)
        XCTAssertTrue(store.isLoaded(a))
        XCTAssertTrue(store.isLoaded(b))
    }

    func testResetClearsEverything() async {
        let a = makeDir("a")
        let store = ExplorerTreeStore()
        await store.expand(a)
        store.selection = [a]

        store.reset()

        XCTAssertTrue(store.expanded.isEmpty)
        XCTAssertTrue(store.selection.isEmpty)
        XCTAssertFalse(store.isLoaded(a))
        XCTAssertFalse(store.isLoaded(root))
    }

    // MARK: - displayRoot

    func testDisplayRootDescendsIntoASingleChildFolder() async {
        let repo = makeDir("only-repo")
        makeFile("only-repo/README.md")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertEqual(ExplorerPaths.key(store.displayRoot(for: root)), ExplorerPaths.key(repo))
    }

    func testDisplayRootStaysAtRootForMultipleChildren() async {
        makeDir("repo-a")
        makeDir("repo-b")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertEqual(ExplorerPaths.key(store.displayRoot(for: root)), ExplorerPaths.key(root))
    }

    func testDisplayRootStaysAtRootForASingleFileChild() async {
        makeFile("solo.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertEqual(ExplorerPaths.key(store.displayRoot(for: root)), ExplorerPaths.key(root),
                       "a lone FILE must not become the display root")
    }

    func testDisplayRootStaysAtRootBeforeChildrenAreLoaded() {
        makeDir("only-repo")
        let store = ExplorerTreeStore()
        XCTAssertEqual(ExplorerPaths.key(store.displayRoot(for: root)), ExplorerPaths.key(root),
                       "displayRoot must be pure — it may not trigger a load")
    }

    // MARK: - flatten

    func testFlattenOfACollapsedTreeIsOnlyTheTopLevel() async {
        makeFile("a.txt")
        makeDir("sub")
        makeFile("sub/b.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)

        let rows = store.flatten(from: root)

        XCTAssertEqual(rows.map(\.name), ["sub", "a.txt"])
        XCTAssertEqual(rows.map(\.depth), [0, 0])
        XCTAssertEqual(rows.map(\.isDirectory), [true, false])
    }

    func testFlattenIncludesChildrenOfExpandedFoldersWithIncreasingDepth() async {
        makeFile("a.txt")
        let sub = makeDir("sub")
        makeFile("sub/b.txt")
        let deep = makeDir("sub/deep")
        makeFile("sub/deep/c.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.expand(sub)
        await store.expand(deep)

        let rows = store.flatten(from: root)

        XCTAssertEqual(rows.map(\.name), ["sub", "deep", "c.txt", "b.txt", "a.txt"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 2, 1, 0])
    }

    func testFlattenRowIdIsTheURL() async {
        let file = makeFile("a.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        let rows = store.flatten(from: root)
        XCTAssertEqual(rows.first?.id, rows.first?.url)
        XCTAssertEqual(ExplorerPaths.key(rows[0].url), ExplorerPaths.key(file))
    }

    /// An expanded folder whose children have not loaded yet contributes no
    /// child rows rather than crashing or blocking — the load lands later and
    /// the list re-renders.
    func testFlattenSkipsExpandedButUnloadedFolders() async {
        let sub = makeDir("sub")
        makeFile("sub/b.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        store.expanded.insert(ExplorerPaths.key(sub))   // expanded WITHOUT loading

        let rows = store.flatten(from: root)

        XCTAssertEqual(rows.map(\.name), ["sub"])
    }

    func testFlattenFromAnUnloadedDisplayRootIsEmpty() {
        makeFile("a.txt")
        let store = ExplorerTreeStore()
        XCTAssertTrue(store.flatten(from: root).isEmpty)
    }

    /// `Row.id` is the row's `URL`, and `List(selection:)` drops a selection
    /// whose id it no longer recognises. So an expand/collapse round trip —
    /// which touches only `expanded`, never the children cache — must hand
    /// back byte-identical ids for every row that stayed visible, or the
    /// user's selection would silently clear when they open a folder.
    func testFlattenRowIdentityIsStableAcrossAnExpandCollapseCycle() async {
        makeFile("a.txt")
        makeFile("設計.txt")
        let sub = makeDir("my docs")
        makeFile("my docs/メモ 1.md")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)

        let before = store.flatten(from: root)
        await store.expand(sub)
        let expandedRows = store.flatten(from: root)
        store.collapse(sub)
        let after = store.flatten(from: root)

        XCTAssertEqual(before.map(\.id), after.map(\.id), "ids must not churn")
        XCTAssertEqual(before, after, "whole rows must be identical, not merely equal by name")
        // The rows that stayed visible keep their exact ids while expanded too.
        let stillVisible = expandedRows.filter { $0.depth == 0 }.map(\.id)
        XCTAssertEqual(before.map(\.id), stillVisible)
        // Re-expanding reuses the cache, so it produces the same rows again.
        await store.expand(sub)
        XCTAssertEqual(expandedRows, store.flatten(from: root))
    }
}

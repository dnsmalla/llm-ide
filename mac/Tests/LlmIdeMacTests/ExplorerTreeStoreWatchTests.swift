import XCTest
@testable import LlmIdeMacLib

/// FIXTURE HAZARD — the temp fixtures below live under `/var/folders`, which is
/// exactly where `ExplorerPaths.key(_:)` is existence-dependent: Foundation
/// folds `/private` only while a path EXISTS, so the same path keys differently
/// once it is deleted. A deleted-path assertion that behaves oddly here is the
/// FIXTURE, not the code — re-root under `$HOME` rather than chasing it. Latent
/// today: no XCTest has ever executed in this repo.
@MainActor
final class ExplorerTreeStoreWatchTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-watch-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    @discardableResult
    private func makeFile(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: Data())
        return url
    }

    @discardableResult
    private func makeDir(_ relative: String) -> URL {
        let url = root.appendingPathComponent(relative)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// FSEvents plus the watcher's debounce is asynchronous and real-clock, so
    /// poll instead of sleeping once — the same shape `GitTruthStoreTests` uses
    /// for its own watcher assertion.
    private func waitForNames(_ expected: [String], in dir: URL,
                              store: ExplorerTreeStore, timeout: TimeInterval = 8) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, store.children(of: dir).map(\.name) != expected {
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        XCTAssertEqual(store.children(of: dir).map(\.name), expected)
    }

    // MARK: - refreshLoaded

    func testRefreshLoadedRePopulatesEveryCachedDirectory() async {
        let sub = makeDir("sub")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.loadChildren(of: sub)

        makeFile("top.txt")
        makeFile("sub/nested.txt")
        await store.refreshLoaded()

        XCTAssertEqual(store.children(of: root).map(\.name), ["sub", "top.txt"])
        XCTAssertEqual(store.children(of: sub).map(\.name), ["nested.txt"])
    }

    func testRefreshLoadedDoesNotLoadDirectoriesThatWereNeverLoaded() async {
        let sub = makeDir("sub")
        makeFile("sub/nested.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)

        await store.refreshLoaded()

        XCTAssertFalse(store.isLoaded(sub), "refresh must not eagerly walk unopened folders")
    }

    func testRefreshLoadedForgetsVanishedDirectoriesAndPrunesState() async {
        let sub = makeDir("sub")
        let file = makeFile("sub/nested.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.expand(sub)
        store.selection = [file]

        try? FileManager.default.removeItem(at: sub)
        await store.refreshLoaded()

        XCTAssertFalse(store.isLoaded(sub))
        XCTAssertFalse(store.expanded.contains(ExplorerPaths.key(sub)))
        XCTAssertTrue(store.selection.isEmpty, "a selected file that no longer exists must be dropped")
    }

    /// The case Tasks 3+4 could not cover: identity across a WATCHER-driven
    /// reload. If a refresh churns `Row.id`, `List(selection:)` silently drops
    /// the user's selection and the outline animation tears.
    func testRefreshLoadedPreservesRowIdentityAndSelection() async {
        let sub = makeDir("サブ フォルダ")
        let kept = makeFile("サブ フォルダ/設計.txt")
        makeFile("with space.txt")

        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.expand(sub)
        store.selection = [kept]

        let before = store.flatten(from: root)
        makeFile("appeared.txt")          // a real change, so the reload is not a no-op
        await store.refreshLoaded()
        let after = store.flatten(from: root)

        XCTAssertTrue(after.count > before.count, "sanity: the refresh actually picked up the new file")
        for row in before {
            guard let match = after.first(where: { $0.url.path == row.url.path }) else {
                XCTFail("row \(row.name) disappeared across a refresh")
                continue
            }
            XCTAssertEqual(match.id, row.id, "Row.id churned across a refresh for \(row.name)")
            XCTAssertEqual(match.id.hashValue, row.id.hashValue)
        }
        XCTAssertEqual(store.selection, [kept], "selection must survive a watcher-driven reload")
        XCTAssertTrue(Set(after.map(\.id)).contains(kept))
    }

    // MARK: - watching

    func testStartWatchingRefreshesWhenAFileAppears() async throws {
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertTrue(store.children(of: root).isEmpty)

        store.startWatching(root)
        defer { store.stopWatching() }

        makeFile("appeared.txt")
        try await waitForNames(["appeared.txt"], in: root, store: store)
    }

    func testStartWatchingSeesDeletesAndRenames() async throws {
        makeFile("設計.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        XCTAssertEqual(store.children(of: root).map(\.name), ["設計.txt"])

        store.startWatching(root)
        defer { store.stopWatching() }

        try FileManager.default.moveItem(at: root.appendingPathComponent("設計.txt"),
                                         to: root.appendingPathComponent("with space.txt"))
        try await waitForNames(["with space.txt"], in: root, store: store)

        try FileManager.default.removeItem(at: root.appendingPathComponent("with space.txt"))
        try await waitForNames([], in: root, store: store)
    }

    func testStopWatchingStopsFurtherRefreshes() async throws {
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        store.startWatching(root)
        store.stopWatching()

        makeFile("appeared.txt")
        try await Task.sleep(nanoseconds: 3_000_000_000)   // > the store's own 1.0s debounce

        XCTAssertTrue(store.children(of: root).isEmpty,
                      "no refresh should have happened after stopWatching")
    }

    func testStartWatchingTwiceReplacesTheWatcherInsteadOfStacking() async throws {
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        store.startWatching(root)
        store.startWatching(root)
        defer { store.stopWatching() }

        makeFile("appeared.txt")
        try await waitForNames(["appeared.txt"], in: root, store: store)

        store.stopWatching()
        makeFile("second.txt")
        try await Task.sleep(nanoseconds: 3_000_000_000)
        XCTAssertEqual(store.children(of: root).map(\.name), ["appeared.txt"],
                       "one stopWatching must silence ALL watchers this store started")
    }

    /// A build writing continuously into a directory the Explorer does not even
    /// display must not starve live updates. The debounce is trailing-edge, so
    /// before the watcher was given the Explorer's own ignore set, churn in
    /// `DerivedData/` restarted the timer on every FSEvents batch and the tree
    /// got NO updates for the build's whole duration.
    func testChurnInAnIgnoredDirectoryDoesNotStarveLiveUpdates() async throws {
        makeDir("DerivedData")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        store.startWatching(root)
        defer { store.stopWatching() }

        let churnRoot = root!
        let churn = Task.detached {
            let end = Date().addingTimeInterval(4)
            var n = 0
            while Date() < end {
                FileManager.default.createFile(
                    atPath: churnRoot.appendingPathComponent("DerivedData/x\(n).o").path,
                    contents: Data())
                n += 1
                try? await Task.sleep(nanoseconds: 40_000_000)
            }
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        makeFile("設計.txt")
        try await waitForNames(["設計.txt"], in: root, store: store)
        _ = await churn.value
    }

    func testResetStopsWatching() async throws {
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        store.startWatching(root)
        store.reset()

        await store.loadChildren(of: root)
        makeFile("appeared.txt")
        try await Task.sleep(nanoseconds: 3_000_000_000)
        XCTAssertTrue(store.children(of: root).isEmpty,
                      "reset() must drop the old workspace's watcher")
    }
}

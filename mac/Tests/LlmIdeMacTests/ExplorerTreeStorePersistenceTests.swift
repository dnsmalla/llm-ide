import XCTest
@testable import LlmIdeMacLib

/// FIXTURE HAZARD — the temp fixtures below live under `/var/folders`, which is
/// exactly where `ExplorerPaths.key(_:)` is existence-dependent: Foundation
/// folds `/private` only while a path EXISTS, so the same path keys differently
/// once it is deleted. This suite asserts on paths ACROSS a delete, so it is
/// the most exposed of the Explorer suites — a deleted-path assertion that
/// behaves oddly here is the FIXTURE, not the code; re-root under `$HOME`
/// rather than chasing it. Latent today: no XCTest has ever executed in this
/// repo.
@MainActor
final class ExplorerTreeStorePersistenceTests: XCTestCase {
    var root: URL!
    var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-persist-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        suiteName = "explorer-tree-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
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

    func testExpansionAndSelectionRoundTrip() async {
        let sub = makeDir("sub")
        let file = makeFile("sub/a.txt")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.selection = [file]
        saver.persistState(for: root, defaults: defaults)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: root, defaults: defaults)

        XCTAssertTrue(loader.expanded.contains(ExplorerPaths.key(sub)))
        XCTAssertEqual(loader.selection.map { ExplorerPaths.key($0) }, [ExplorerPaths.key(file)])
    }

    /// The bug this whole design exists to prevent: a restored selection that
    /// decodes perfectly and then selects NOTHING, because `List(selection:)`
    /// matches by raw `URL` hashing and the restored URL is a different
    /// spelling of the same file (`/var/…` vs `/private/var/…`).
    ///
    /// So assert against the real `Row` ids, not against `ExplorerPaths.key`.
    /// Non-ASCII and space-bearing names included: this project's users work
    /// in Japanese, and both are known-hazardous here.
    func testRestoredSelectionMatchesActualRowIdentity() async {
        let sub = makeDir("サブ フォルダ")
        let file = makeFile("サブ フォルダ/設計.txt")
        let spaced = makeFile("with space.txt")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.selection = [file, spaced, sub]
        saver.persistState(for: root, defaults: defaults)

        let loader = ExplorerTreeStore()
        await loader.loadChildren(of: root)
        await loader.restoreState(for: root, defaults: defaults)

        let rowIDs = Set(loader.flatten(from: root).map(\.id))
        XCTAssertEqual(loader.selection.count, 3)
        for selected in loader.selection {
            XCTAssertTrue(rowIDs.contains(selected),
                          "restored selection \(selected.path) matches no rendered row id")
        }
    }

    /// Both spellings of one workspace must reach the same stored blob, and a
    /// selection saved under one must select under the other.
    func testStateSavedUnderOneRootSpellingRestoresUnderTheOther() async {
        let file = makeFile("設計.txt")
        // Derive the OTHER spelling of the same directory rather than asserting
        // which one `canonical` produces — the fold direction is a platform
        // detail (it folds toward the SHORT form here) and the contract is that
        // the two spellings agree, not that a particular literal wins.
        let canon = ExplorerPaths.canonical(root).path
        let otherSpelling = canon.hasPrefix("/private/")
            ? URL(fileURLWithPath: String(canon.dropFirst("/private".count)))
            : URL(fileURLWithPath: "/private" + canon)
        guard FileManager.default.fileExists(atPath: otherSpelling.path) else {
            return   // no /private alias for this temp location; nothing to prove
        }

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        saver.selection = [file]
        saver.persistState(for: root, defaults: defaults)

        XCTAssertEqual(ExplorerTreeStore.defaultsKey(for: root),
                       ExplorerTreeStore.defaultsKey(for: otherSpelling),
                       "two spellings of one workspace must share one defaults key")

        let loader = ExplorerTreeStore()
        await loader.loadChildren(of: otherSpelling)
        await loader.restoreState(for: otherSpelling, defaults: defaults)

        let rowIDs = Set(loader.flatten(from: otherSpelling).map(\.id))
        XCTAssertEqual(loader.selection.count, 1)
        XCTAssertTrue(rowIDs.contains(loader.selection.first!))
    }

    /// A restore-ONLY wiring — no `loadChildren` first — must render rows.
    /// `persistState` skips the root itself, so the root is never in the
    /// stored expansion set; before this was fixed, restore reinstated
    /// expansion and selection onto an empty cache and `flatten` returned
    /// ZERO rows, silently. Every other test here loads the root first and so
    /// cannot see it.
    func testRestoreOnlyWiringRendersRows() async {
        let sub = makeDir("サブ フォルダ")
        let file = makeFile("サブ フォルダ/設計.txt")
        makeFile("with space.txt")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.selection = [file]
        saver.persistState(for: root, defaults: defaults)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: root, defaults: defaults)   // and nothing else

        XCTAssertTrue(loader.isLoaded(root), "restore must leave the root loaded")
        let rows = loader.flatten(from: root)
        XCTAssertFalse(rows.isEmpty, "restore-only wiring rendered an empty tree")
        XCTAssertTrue(rows.contains { $0.name == "設計.txt" })
        let selected = loader.selection.first
        XCTAssertNotNil(selected)
        if let selected {
            XCTAssertTrue(Set(rows.map(\.id)).contains(selected),
                          "restored selection matches no rendered row")
        }
    }

    /// The root loads even when there is nothing stored, so a first run and a
    /// restored run reach the same rendered state through one call.
    func testRestoreWithNoStoredStateStillLoadsTheRoot() async {
        makeFile("a.txt")
        let store = ExplorerTreeStore()
        await store.restoreState(for: root, defaults: defaults)
        XCTAssertTrue(store.isLoaded(root))
        XCTAssertEqual(store.flatten(from: root).map(\.name), ["a.txt"])
    }

    /// A restore spans several loads, so a project switch can land while one is
    /// suspended part-way through. The superseded restore must write nothing
    /// further — otherwise it re-inserts the PREVIOUS project's expansion keys
    /// onto the new tree — and must report that it did not complete.
    func testASupersededRestoreWritesNothingAndReportsFalse() async {
        var dirs: [URL] = []
        for d in 0..<12 {
            dirs.append(makeDir("サブ フォルダ\(d)"))
            for i in 0..<60 { makeFile("サブ フォルダ\(d)/f\(i).txt") }
        }
        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        for dir in dirs { await saver.expand(dir) }
        saver.selection = [makeFile("設計.txt")]
        saver.persistState(for: root, defaults: defaults)

        let store = ExplorerTreeStore()
        async let restored: Bool = store.restoreState(for: root, defaults: defaults)
        for _ in 0..<10 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 2_000_000)
        store.reset()                       // the project switch
        let completed = await restored

        XCTAssertFalse(completed, "a superseded restore must not report completion")
        XCTAssertTrue(store.expanded.isEmpty, "stale expansion survived a project switch")
        XCTAssertTrue(store.selection.isEmpty, "stale selection survived a project switch")
    }

    /// The completion signal must be true for a restore that was NOT
    /// superseded — it is what the view keys "safe to persist again" on.
    func testACleanRestoreReportsCompletion() async {
        let sub = makeDir("sub")
        makeFile("sub/a.txt")
        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.persistState(for: root, defaults: defaults)

        let store = ExplorerTreeStore()
        let completed = await store.restoreState(for: root, defaults: defaults)

        XCTAssertTrue(completed)
        XCTAssertTrue(store.expanded.contains(ExplorerPaths.key(sub)))
        XCTAssertFalse(store.flatten(from: root).isEmpty)
    }

    func testANewerRestoreSupersedesAnOlderOne() async {
        let sub = makeDir("sub")
        for i in 0..<60 { makeFile("sub/f\(i).txt") }
        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.persistState(for: root, defaults: defaults)

        let store = ExplorerTreeStore()
        async let first: Bool = store.restoreState(for: root, defaults: defaults)
        // Wait for `first` to be DEMONSTRABLY in flight instead of guessing at
        // scheduling: 10 yields + 2 ms let a fast CI runner finish `first`
        // outright, and a single yield let this continuation win the actor
        // before the child had even started (CI runs 33966040845, 33967357832).
        // `isLoaded(root)` flips inside `first` right after its first await,
        // and the very next thing `first` does is suspend again on the 60-file
        // listing of `sub` — so once it reads true, `second` is guaranteed to
        // start while `first` is still in flight. Bounded so a broken store
        // fails the test instead of hanging it.
        let base = ExplorerPaths.canonical(root)
        var spins = 0
        while !store.isLoaded(base), spins < 100_000 {
            await Task.yield()
            spins += 1
        }
        XCTAssertTrue(store.isLoaded(base), "first restore never loaded the root")
        let second = await store.restoreState(for: root, defaults: defaults)
        let firstCompleted = await first

        XCTAssertTrue(second, "the newest restore must complete")
        XCTAssertFalse(firstCompleted, "the superseded restore must report false")
    }

    /// `invalidate` must drop the in-flight load as well as the children, or
    /// that load writes the PRE-invalidate listing back and `isLoaded` then
    /// answers true forever. The toolbar Refresh path is invalidate + reload.
    func testInvalidateIsNotUndoneByAnInFlightLoad() async {
        for i in 0..<60 { makeFile("f\(i).txt") }
        let store = ExplorerTreeStore()

        async let load: Void = store.loadChildren(of: root)
        for _ in 0..<10 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 2_000_000)
        makeFile("zz-after.txt")
        store.invalidate(root)
        await load

        XCTAssertFalse(store.isLoaded(root),
                       "an in-flight load repopulated a directory that was invalidated")
    }

    /// Restoring an expanded folder must also have LOADED it, or the tree
    /// renders the folder open and empty until the user pokes it.
    func testRestoreLoadsTheChildrenOfRestoredExpandedFolders() async {
        let sub = makeDir("sub")
        makeFile("sub/a.txt")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.persistState(for: root, defaults: defaults)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: root, defaults: defaults)

        XCTAssertTrue(loader.isLoaded(sub))
        XCTAssertEqual(loader.children(of: sub).map(\.name), ["a.txt"])
    }

    func testPathsThatNoLongerExistAreDropped() async {
        let doomedDir = makeDir("doomed")
        let doomedFile = makeFile("doomed/x.txt")
        let survivor = makeDir("survivor")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(doomedDir)
        await saver.expand(survivor)
        saver.selection = [doomedFile]
        saver.persistState(for: root, defaults: defaults)

        try? FileManager.default.removeItem(at: doomedDir)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: root, defaults: defaults)

        XCTAssertFalse(loader.expanded.contains(ExplorerPaths.key(doomedDir)))
        XCTAssertTrue(loader.expanded.contains(ExplorerPaths.key(survivor)))
        XCTAssertTrue(loader.selection.isEmpty)
    }

    /// Root-relative storage is what lets a moved/re-cloned project restore.
    func testStateRestoresUnderADifferentAbsoluteRoot() async {
        let sub = makeDir("sub")
        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.persistState(for: root, defaults: defaults)

        // Simulate the same project at a new path: copy the tree, then restore
        // using the ORIGINAL root's key but the NEW root's URLs.
        let moved = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-persist-moved-\(UUID().uuidString)")
        try? FileManager.default.copyItem(at: root, to: moved)
        defer { try? FileManager.default.removeItem(at: moved) }
        let raw = defaults.data(forKey: ExplorerTreeStore.defaultsKey(for: root))
        defaults.set(raw, forKey: ExplorerTreeStore.defaultsKey(for: moved))

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: moved, defaults: defaults)

        XCTAssertTrue(loader.expanded.contains(ExplorerPaths.key(moved.appendingPathComponent("sub"))))
    }

    func testRestoreWithNoStoredStateLeavesTheStoreEmpty() async {
        let store = ExplorerTreeStore()
        await store.restoreState(for: root, defaults: defaults)
        XCTAssertTrue(store.expanded.isEmpty)
        XCTAssertTrue(store.selection.isEmpty)
    }

    func testTwoRootsKeepSeparateState() async {
        let otherRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("explorer-persist-other-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: otherRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: otherRoot) }
        let sub = makeDir("sub")

        let saver = ExplorerTreeStore()
        await saver.loadChildren(of: root)
        await saver.expand(sub)
        saver.persistState(for: root, defaults: defaults)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: otherRoot, defaults: defaults)
        XCTAssertTrue(loader.expanded.isEmpty)
    }

    // MARK: - Selection pruning (Tasks 3+4 review, M2)
    //
    // Persisting a selection is only safe if the selection is trustworthy:
    // SwiftUI keeps ids whose rows stopped rendering, and Task 11's bulk
    // delete reads this set.

    func testCollapsingAFolderDropsItsDescendantsFromTheSelection() async {
        let sub = makeDir("sub")
        let deep = makeDir("sub/deep")
        let inner = makeFile("sub/deep/x.txt")
        let outside = makeFile("top.txt")

        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.expand(sub)
        await store.expand(deep)
        store.selection = [inner, deep, outside, sub]

        store.collapse(sub)

        XCTAssertFalse(store.selection.contains(inner))
        XCTAssertFalse(store.selection.contains(deep))
        XCTAssertTrue(store.selection.contains(outside), "a sibling row is still on screen")
        XCTAssertTrue(store.selection.contains(sub), "the collapsed folder's OWN row is still on screen")
    }

    func testCollapseAllClearsTheSelection() async {
        let sub = makeDir("sub")
        let file = makeFile("sub/x.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.expand(sub)
        store.selection = [file]

        store.collapseAll()

        XCTAssertTrue(store.selection.isEmpty)
    }

    func testAPrunedSelectionIsNotPersisted() async {
        let sub = makeDir("sub")
        let inner = makeFile("sub/x.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)
        await store.expand(sub)
        store.selection = [inner]
        store.collapse(sub)
        store.persistState(for: root, defaults: defaults)

        let loader = ExplorerTreeStore()
        await loader.restoreState(for: root, defaults: defaults)
        XCTAssertTrue(loader.selection.isEmpty)
    }

    // MARK: - Load ordering (Tasks 3+4 review, M1/M3)

    func testResetIsNotUndoneByAnInFlightLoad() async {
        for i in 0..<60 { makeFile("f\(i).txt") }
        let store = ExplorerTreeStore()

        async let load: Void = store.loadChildren(of: root)
        // `loadChildren` takes its ticket synchronously and then suspends on
        // the detached walk. A single `Task.yield()` usually lets it get that
        // far but measured 1-in-40 flaky, so yield repeatedly AND sleep — the
        // load must genuinely be IN FLIGHT or this asserts nothing.
        for _ in 0..<10 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 2_000_000)
        store.reset()
        await load

        XCTAssertTrue(store.children(of: root).isEmpty)
        XCTAssertFalse(store.isLoaded(root), "an in-flight load must not repopulate after reset()")
    }

    /// A slow user-initiated load must not land stale children over a newer
    /// refresh. Task 6's watcher is what makes this reachable in practice.
    func testANewerLoadWinsOverASlowerOlderOne() async {
        for i in 0..<400 { makeFile("f\(i).txt") }
        let store = ExplorerTreeStore()

        async let slow: Void = store.loadChildren(of: root)
        for _ in 0..<10 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 2_000_000)
        makeFile("zz-newest.txt")
        await store.loadChildren(of: root)   // newer load, completes first
        await slow

        XCTAssertTrue(store.children(of: root).contains { $0.name == "zz-newest.txt" },
                      "the older load overwrote the newer one's result")
    }

    func testTwoQuickTogglesNetToCollapsed() async {
        let sub = makeDir("sub")
        makeFile("sub/x.txt")
        let store = ExplorerTreeStore()
        await store.loadChildren(of: root)

        async let first: Void = store.toggle(sub)
        async let second: Void = store.toggle(sub)
        _ = await (first, second)

        XCTAssertFalse(store.expanded.contains(ExplorerPaths.key(sub)),
                       "an even number of toggles must leave the folder collapsed")
    }
}

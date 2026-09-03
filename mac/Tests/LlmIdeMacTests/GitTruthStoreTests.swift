import XCTest
@testable import LlmIdeMacLib

@MainActor
final class GitTruthStoreTests: XCTestCase {
    var repo: URL!

    override func setUp() async throws {
        try await super.setUp()
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("git-truth-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try run(["init", "-q"])
        try run(["config", "user.email", "test@example.com"])
        try run(["config", "user.name", "Test"])
        try "line1\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        try run(["add", "-A"])
        try run(["commit", "-q", "-m", "init"])
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
        super.tearDown()
    }

    @discardableResult
    private func run(_ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = args
        p.currentDirectoryURL = repo
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    // MARK: - The regression this store exists to fix (design doc finding #1):
    // a root with no `.git` (e.g. a container folder holding several clones)
    // must report NO decorations, never throw, never crash.

    func testRefreshOnNonGitRootProducesNoDecorations() async {
        let notARepo = FileManager.default.temporaryDirectory
            .appendingPathComponent("not-a-repo-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: notARepo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: notARepo) }

        let store = GitTruthStore()
        await store.refresh(root: notARepo)
        XCTAssertTrue(store.byPath.isEmpty)
        XCTAssertTrue(store.dirsWithChanges.isEmpty)
    }

    func testRefreshOnRealRepoPopulatesStatus() async throws {
        try "line1\nline2\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        try "new\n".write(to: repo.appendingPathComponent("added.txt"), atomically: true, encoding: .utf8)

        let store = GitTruthStore()
        await store.refresh(root: repo)

        XCTAssertEqual(store.byPath["tracked.txt"], .modified)
        XCTAssertEqual(store.byPath["added.txt"], .untracked)
    }

    func testDirsWithChangesRollsUpToEveryAncestor() async throws {
        try FileManager.default.createDirectory(
            at: repo.appendingPathComponent("a/b"), withIntermediateDirectories: true)
        try "x\n".write(to: repo.appendingPathComponent("a/b/c.txt"), atomically: true, encoding: .utf8)

        let store = GitTruthStore()
        await store.refresh(root: repo)

        XCTAssertTrue(store.dirsWithChanges.contains("a"))
        XCTAssertTrue(store.dirsWithChanges.contains("a/b"))
    }

    func testDecorationForAbsoluteResolvesRelativeToRoot() async throws {
        try "changed\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        let store = GitTruthStore()
        await store.refresh(root: repo)

        let fileURL = repo.appendingPathComponent("tracked.txt")
        XCTAssertEqual(store.decoration(forAbsolute: fileURL, root: repo, isDirectory: false), .modified)

        let outsideURL = URL(fileURLWithPath: "/tmp/unrelated.txt")
        XCTAssertNil(store.decoration(forAbsolute: outsideURL, root: repo, isDirectory: false))
    }

    // MARK: - lineMarks

    func testLineMarksForModifiedTrackedFile() async throws {
        try "line1\nCHANGED\nline3\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        let store = GitTruthStore()
        await store.refresh(root: repo)
        let marks = await store.lineMarks(root: repo, path: "tracked.txt")
        XCTAssertEqual(marks[2], .modified)
    }

    func testLineMarksForStagedAndUnstagedChangesBothAppear() async throws {
        // Stage one change, leave another unstaged, in the same file.
        try "STAGED\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        try run(["add", "-A"])
        try "STAGED\nUNSTAGED\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)

        let store = GitTruthStore()
        await store.refresh(root: repo)
        let marks = await store.lineMarks(root: repo, path: "tracked.txt")
        // Both lines differ from HEAD (which still has "line1"), regardless
        // of staged/unstaged — `git diff HEAD` sees the whole delta at once.
        XCTAssertEqual(marks[1], .modified)
        XCTAssertEqual(marks[2], .added)
    }

    func testLineMarksForNewUntrackedFileMarksEveryLineAdded() async throws {
        try "a\nb\nc\n".write(to: repo.appendingPathComponent("new.txt"), atomically: true, encoding: .utf8)
        let store = GitTruthStore()
        await store.refresh(root: repo)
        let marks = await store.lineMarks(root: repo, path: "new.txt")
        XCTAssertEqual(marks, [1: .added, 2: .added, 3: .added])
    }

    func testLineMarksForCleanFileIsEmpty() async throws {
        let store = GitTruthStore()
        await store.refresh(root: repo)
        let marks = await store.lineMarks(root: repo, path: "tracked.txt")
        XCTAssertTrue(marks.isEmpty)
    }

    // MARK: - startWatching

    func testStartWatchingRefreshesOnFileChange() async throws {
        let store = GitTruthStore()
        await store.refresh(root: repo)
        XCTAssertTrue(store.byPath.isEmpty)

        store.startWatching(root: repo)
        defer { store.stopWatching() }

        try "changed\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)

        // FSEvents + the watcher's debounce is asynchronous and real-clock —
        // poll rather than sleep-then-assert-once, so this isn't flaky on a
        // loaded CI machine.
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline, store.byPath["tracked.txt"] != .modified {
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        XCTAssertEqual(store.byPath["tracked.txt"], .modified)
    }

    func testStopWatchingStopsFurtherRefreshes() async throws {
        let store = GitTruthStore()
        await store.refresh(root: repo)
        store.startWatching(root: repo)
        store.stopWatching()

        try "changed\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        try await Task.sleep(nanoseconds: 3_000_000_000)   // longer than the watcher's own 2s debounce
        XCTAssertTrue(store.byPath.isEmpty, "no refresh should have happened after stopWatching")
    }
}

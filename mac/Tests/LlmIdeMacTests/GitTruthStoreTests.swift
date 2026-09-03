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
}

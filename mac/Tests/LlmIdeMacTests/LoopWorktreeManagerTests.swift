import XCTest
@testable import LlmIdeMacLib

@MainActor
final class LoopWorktreeManagerTests: XCTestCase {
    private var base: URL!
    private var mainRepo: URL!
    private var projectRoot: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        LoopWorktreeManager._resetForTesting()
        base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-worktree-\(UUID().uuidString)", isDirectory: true)
        mainRepo = base.appendingPathComponent("repo", isDirectory: true)
        projectRoot = base.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: mainRepo, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: projectRoot, withIntermediateDirectories: true)
        try initGitRepo(at: mainRepo)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
        LoopWorktreeManager._resetForTesting()
        try super.tearDownWithError()
    }

    func testFinishRemovesUnchangedWorktree() async throws {
        let lease = try await LoopWorktreeManager.create(mainRepo: mainRepo, faultsRoot: projectRoot)
        XCTAssertTrue(FileManager.default.fileExists(atPath: lease.worktreePath.path))
        XCTAssertEqual(LoopWorktreeManager.activeWorktreeRunCount(mainRepo: mainRepo), 1)

        await LoopWorktreeManager.finish(lease)
        XCTAssertFalse(FileManager.default.fileExists(atPath: lease.worktreePath.path))
        XCTAssertEqual(LoopWorktreeManager.activeWorktreeRunCount(mainRepo: mainRepo), 0)
    }

    func testFinishPreservesDirtyWorktreeAndBranch() async throws {
        let lease = try await LoopWorktreeManager.create(mainRepo: mainRepo, faultsRoot: projectRoot)
        try Data("repair".utf8).write(
            to: lease.worktreePath.appendingPathComponent("repaired.txt"))

        await LoopWorktreeManager.finish(lease)

        XCTAssertTrue(FileManager.default.fileExists(atPath: lease.worktreePath.path),
                      "Loop output must not be deleted during cleanup")
        XCTAssertEqual(LoopWorktreeManager.activeWorktreeRunCount(mainRepo: mainRepo), 0)
        let branches = try await RepoManager().runGit(["branch", "--list", lease.branch],
                                                       at: mainRepo)
        XCTAssertTrue(branches.contains(lease.branch))
    }

    func testCreateIfPossibleReturnsNilForNonRepo() async {
        let notRepo = projectRoot.appendingPathComponent("not-git", isDirectory: true)
        try? FileManager.default.createDirectory(at: notRepo, withIntermediateDirectories: true)
        let lease = await LoopWorktreeManager.createIfPossible(mainRepo: notRepo, faultsRoot: projectRoot)
        XCTAssertNil(lease)
    }

    func testCreateIfPossibleReturnsNilForDirtyMainRepo() async throws {
        try Data("uncommitted".utf8).write(
            to: mainRepo.appendingPathComponent("working-copy.txt"))

        let lease = await LoopWorktreeManager.createIfPossible(
            mainRepo: mainRepo, faultsRoot: projectRoot)

        XCTAssertNil(lease, "a worktree from HEAD would silently omit current edits")
    }

    private func initGitRepo(at repo: URL) throws {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        proc.currentDirectoryURL = repo
        proc.arguments = ["init", "-q"]
        try proc.run()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else {
            throw NSError(domain: "test", code: 1)
        }
        for args in [
            ["config", "user.email", "t@example.com"],
            ["config", "user.name", "T"],
            ["commit", "--allow-empty", "-qm", "init"],
        ] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.currentDirectoryURL = repo
            p.arguments = args
            try p.run()
            p.waitUntilExit()
        }
    }
}

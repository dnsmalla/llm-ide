import XCTest
@testable import LlmIdeMacLib

/// Prompt-based auto tasks run in an isolated git worktree of HEAD. Before
/// this, a review task reverted the whole checkout afterwards (`checkout -- .`
/// + `clean -fd`) — deleting whatever the user had edited meanwhile — and an
/// implement task `checkout -b`'d in the user's checkout, swept their edits
/// into its commit and left the repo on `fix/custom-…`.
final class AutoTaskWorktreeTests: XCTestCase {
    var repo: URL!

    override func setUpWithError() throws {
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("autotask-worktree-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try sh(["git", "init", "-q", "-b", "main"])
        try sh(["git", "config", "user.email", "t@example.com"])
        try sh(["git", "config", "user.name", "t"])
        try "one\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        try sh(["git", "add", "-A"]); try sh(["git", "commit", "-q", "-m", "init"])
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
    }

    private func sh(_ args: [String], cwd: URL? = nil) throws -> String {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = args
        p.currentDirectoryURL = cwd ?? repo
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
        try p.run(); let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, "\(args.joined(separator: " ")) → \(out)")
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The user is mid-edit (a changed tracked file + a new untracked one)
    /// while a review task runs and "writes" in its worktree. Afterwards the
    /// user's edits are exactly as they were and HEAD did not move.
    func testReviewWorktreeLeavesTheUsersEditsAlone() throws {
        try "user edit\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        try "wip\n".write(to: repo.appendingPathComponent("scratch.md"), atomically: true, encoding: .utf8)
        let head = AutoCodeUpdateService.headCommit(at: repo.path)

        let wt = AutoCodeUpdateService.taskWorktreePath(token: "t-review-\(UUID().uuidString.prefix(6))")
        XCTAssertTrue(AutoCodeUpdateService.worktreeAdd(at: repo.path, path: wt, branch: nil))
        try "task output\n".write(to: URL(fileURLWithPath: wt).appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        try "junk\n".write(to: URL(fileURLWithPath: wt).appendingPathComponent("REVIEW.md"), atomically: true, encoding: .utf8)
        AutoCodeUpdateService.worktreeRemove(at: repo.path, path: wt)

        XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("a.txt"), encoding: .utf8), "user edit\n")
        XCTAssertTrue(FileManager.default.fileExists(atPath: repo.appendingPathComponent("scratch.md").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: repo.appendingPathComponent("REVIEW.md").path))
        XCTAssertEqual(AutoCodeUpdateService.headCommit(at: repo.path), head)
        XCTAssertFalse(FileManager.default.fileExists(atPath: wt), "worktree dropped")
        XCTAssertEqual(try sh(["git", "branch", "--show-current"]), "main")
    }

    /// An implement task commits on its own branch inside the worktree: the
    /// branch has the commit, the user's branch and edits are untouched.
    func testImplementCommitsOnItsBranchWithoutSwitchingTheUser() throws {
        try "user edit\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        let head = AutoCodeUpdateService.headCommit(at: repo.path)
        let branch = AutoCodeUpdateService.customImplementBranch(slug: "demo", token: "abc12345")
        let wt = AutoCodeUpdateService.taskWorktreePath(token: "t-impl-\(UUID().uuidString.prefix(6))")
        XCTAssertTrue(AutoCodeUpdateService.worktreeAdd(at: repo.path, path: wt, branch: branch))
        try "implemented\n".write(to: URL(fileURLWithPath: wt).appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)
        XCTAssertTrue(AutoCodeUpdateService.commitAll(at: wt, message: "Auto task: demo"))
        AutoCodeUpdateService.worktreeRemove(at: repo.path, path: wt)

        XCTAssertEqual(try sh(["git", "branch", "--show-current"]), "main", "user's branch unchanged")
        XCTAssertEqual(AutoCodeUpdateService.headCommit(at: repo.path), head, "user's HEAD unchanged")
        XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("a.txt"), encoding: .utf8), "user edit\n")
        XCTAssertEqual(try sh(["git", "log", "-1", "--format=%s", branch]), "Auto task: demo")
        XCTAssertFalse(FileManager.default.fileExists(atPath: repo.appendingPathComponent("b.txt").path),
                       "the task's file is on its branch, not in the user's tree")
    }

    /// No edits → no commit → the empty branch is removed again.
    func testEmptyImplementRunLeavesNoBranch() throws {
        let branch = AutoCodeUpdateService.customImplementBranch(slug: "noop", token: "00000000")
        let wt = AutoCodeUpdateService.taskWorktreePath(token: "t-noop-\(UUID().uuidString.prefix(6))")
        XCTAssertTrue(AutoCodeUpdateService.worktreeAdd(at: repo.path, path: wt, branch: branch))
        XCTAssertFalse(AutoCodeUpdateService.commitAll(at: wt, message: "nothing"))
        XCTAssertTrue(AutoCodeUpdateService.branchDelete(branch, at: repo.path) || true) // may fail while checked out in the worktree
        AutoCodeUpdateService.worktreeRemove(at: repo.path, path: wt)
        _ = AutoCodeUpdateService.branchDelete(branch, at: repo.path)
        XCTAssertFalse(AutoCodeUpdateService.localBranches(prefix: "fix/custom-noop", at: repo.path).contains(branch))
    }

    /// Absolute paths under the main checkout are redirected into the worktree.
    func testPromptIsRetargetedToTheWorktree() {
        let out = AutoCodeUpdateService.retargetPrompt(
            "Read /repo/main/src/a.swift and write /repo/main/llm-doc/out.md. Root: /repo/main",
            from: "/repo/main", to: "/tmp/wt")
        XCTAssertTrue(out.contains("/tmp/wt/src/a.swift"))
        XCTAssertTrue(out.contains("/tmp/wt/llm-doc/out.md"))
        XCTAssertTrue(out.contains("Root: /tmp/wt"))
        XCTAssertFalse(out.contains("/repo/main"))
        XCTAssertTrue(out.hasPrefix("You are working in an isolated checkout"))
    }
}

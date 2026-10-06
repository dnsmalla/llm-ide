import Testing
import Foundation
@testable import LlmIdeMacLib

/// The issue-implement Auto Task works in an isolated worktree on its own
/// branch; these pin the branch naming and that a worktree branch leaves the
/// user's checkout alone.
@Suite("Issue implement worktree", .serialized)
struct IssueImplementWorktreeTests {
    @Test func plannedNameIsUsedWhenFree() {
        let name = AutoCodeUpdateService.issueBranchName(planned: "fix/7-null-crash", token: "ab12cd34", plannedExists: false)
        #expect(name == "fix/7-null-crash")
    }

    @Test func existingBranchGetsTheRunToken() {
        let name = AutoCodeUpdateService.issueBranchName(planned: "fix/7-null-crash", token: "ab12cd34", plannedExists: true)
        #expect(name == "fix/7-null-crash-ab12cd34")
        // Still a pipeline branch, so review-merge picks it up.
        #expect(AutoCodeUpdateService.isPipelineBranch(name))
    }

    @Test func worktreeBranchLeavesTheUsersCheckoutUntouched() throws {
        let fm = FileManager.default
        let repo = fm.temporaryDirectory.appendingPathComponent("impl-wt-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: repo) }
        func git(_ args: [String], in dir: URL) throws {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-C", dir.path, "-c", "user.name=t", "-c", "user.email=t@t",
                                 "-c", "commit.gpgsign=false"] + args
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            #expect(process.terminationStatus == 0, "git \(args.joined(separator: " "))")
        }
        try git(["init", "-q", "-b", "feature"], in: repo)
        try "one\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        try git(["add", "-A"], in: repo)
        try git(["commit", "-q", "-m", "init"], in: repo)
        // The user has uncommitted work on their own branch.
        try "mine\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        let headBefore = AutoCodeUpdateService.headCommit(at: repo.path)

        let token = AutoCodeUpdateService.shortToken()
        let worktree = AutoCodeUpdateService.taskWorktreePath(token: token)
        #expect(AutoCodeUpdateService.worktreeAdd(at: repo.path, path: worktree, branch: "fix/1-x"))
        try "fixed\n".write(to: URL(fileURLWithPath: worktree).appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        #expect(AutoCodeUpdateService.commitAll(at: worktree, message: "fix"))
        AutoCodeUpdateService.worktreeRemove(at: repo.path, path: worktree)

        #expect(AutoCodeUpdateService.currentBranch(at: repo.path) == "feature")
        #expect(AutoCodeUpdateService.headCommit(at: repo.path) == headBefore)
        #expect(try String(contentsOf: repo.appendingPathComponent("a.txt"), encoding: .utf8) == "mine\n")
        #expect(AutoCodeUpdateService.refSha("refs/heads/fix/1-x", at: repo.path) != nil)
    }
}

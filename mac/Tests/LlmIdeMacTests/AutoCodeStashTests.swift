import Testing
import Foundation
@testable import LlmIdeMac

/// Real-git round-trip for the opt-in auto-stash safety behavior.
struct AutoCodeStashTests {
    private func git(_ args: [String], at repo: URL) {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", repo.path] + args
        p.standardOutput = Pipe(); p.standardError = Pipe()
        try? p.run(); p.waitUntilExit()
    }

    private func makeRepo() throws -> URL {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("stash-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        git(["init", "-q"], at: repo)
        git(["config", "user.email", "t@t.t"], at: repo)
        git(["config", "user.name", "t"], at: repo)
        git(["symbolic-ref", "HEAD", "refs/heads/main"], at: repo)
        try "base\n".write(to: repo.appendingPathComponent("file.txt"), atomically: true, encoding: .utf8)
        git(["add", "."], at: repo); git(["commit", "-q", "-m", "init"], at: repo)
        return repo
    }

    @Test func stashThenRestoreRoundTripsWIP() throws {
        let repo = try makeRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let file = repo.appendingPathComponent("file.txt")
        try "base\nWIP edit\n".write(to: file, atomically: true, encoding: .utf8)

        #expect(AutoCodeUpdateService.isWorkingTreeClean(at: repo.path) == false)
        let branch = AutoCodeUpdateService.currentBranch(at: repo.path)
        #expect(branch == "main")

        #expect(AutoCodeUpdateService.stashPush(at: repo.path) == true)
        // Tree is clean after stashing — auto-tasks can now run.
        #expect(AutoCodeUpdateService.isWorkingTreeClean(at: repo.path) == true)

        let restored = AutoCodeUpdateService.restoreStash(at: repo.path, originalBranch: branch)
        #expect(restored == true)
        // WIP is back.
        #expect(try String(contentsOf: file, encoding: .utf8).contains("WIP edit"))
        #expect(AutoCodeUpdateService.isWorkingTreeClean(at: repo.path) == false)
    }

    @Test func stashPushReportsFalseOnCleanTree() throws {
        let repo = try makeRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        // Nothing modified — no stash should be created.
        #expect(AutoCodeUpdateService.stashPush(at: repo.path) == false)
    }

    @Test func restoreReturnsToOriginalBranchAfterCLISwitched() throws {
        let repo = try makeRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let file = repo.appendingPathComponent("file.txt")
        try "base\nWIP\n".write(to: file, atomically: true, encoding: .utf8)
        _ = AutoCodeUpdateService.stashPush(at: repo.path)
        // Simulate the CLI creating + switching to a fix branch.
        git(["checkout", "-q", "-b", "fix/123"], at: repo)

        let ok = AutoCodeUpdateService.restoreStash(at: repo.path, originalBranch: "main")
        #expect(ok == true)
        // WIP restored onto main, not the fix branch.
        #expect(AutoCodeUpdateService.currentBranch(at: repo.path) == "main")
        #expect(try String(contentsOf: file, encoding: .utf8).contains("WIP"))
    }
}

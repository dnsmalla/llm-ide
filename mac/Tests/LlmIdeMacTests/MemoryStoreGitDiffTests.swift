import Testing
import Foundation
@testable import LlmIdeMac

struct MemoryStoreGitDiffTests {
    @Test func gitDiffReportsChangedPaths() throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gitdiff-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }

        func git(_ args: [String]) throws {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = ["-C", repo.path] + args
            p.standardOutput = Pipe(); p.standardError = Pipe()
            try p.run(); p.waitUntilExit()
        }
        try git(["init", "-q"])
        try git(["config", "user.email", "t@t.t"])
        try git(["config", "user.name", "t"])
        let file = repo.appendingPathComponent("a.txt")
        try "one\n".write(to: file, atomically: true, encoding: .utf8)
        try git(["add", "."]); try git(["commit", "-q", "-m", "init"])
        try "two\n".write(to: file, atomically: true, encoding: .utf8)   // dirty the tree

        let store = MemoryStore()
        let diff = try store.gitDiff(at: repo)
        #expect(diff.changedPaths.contains("a.txt"))
        #expect(diff.unified.contains("two"))

        try store.gitCheckout(at: repo, paths: ["a.txt"])
        let after = try store.gitDiff(at: repo)
        #expect(after.changedPaths.isEmpty)   // checkout reverted it
    }
}

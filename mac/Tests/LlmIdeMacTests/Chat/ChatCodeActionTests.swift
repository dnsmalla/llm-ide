import Testing
import Foundation
@testable import LlmIdeMacLib

/// Regressions from the 2026-09 chat review (F8, code actions from chat).
@Suite("Chat code actions")
struct ChatCodeActionTests {
    // MARK: - Ref / URL validation

    @Test("Agent-supplied refs that git would read as options are refused")
    func safeRefRefusesOptions() throws {
        for bad in ["-D", "-f", "--template=/tmp/x", "--config=core.sshCommand=touch /tmp/p", "", "a b"] {
            #expect(throws: (any Error).self, "\(bad) must be refused") { try RepoManager.safeRef(bad) }
        }
        #expect(try RepoManager.safeRef(" feature/x ") == "feature/x")
    }

    @Test("clone only accepts remote repository URLs")
    func cloneURLShape() {
        #expect(RepoManager.isCloneURL("https://github.com/o/r.git"))
        #expect(RepoManager.isCloneURL("git@github.com:o/r.git"))
        #expect(RepoManager.isCloneURL("ssh://git@host/o/r.git"))
        #expect(!RepoManager.isCloneURL("/etc"))
        #expect(!RepoManager.isCloneURL("file:///etc"))
        #expect(!RepoManager.isCloneURL("ext::sh -c touch% /tmp/pwned"))
    }

    // MARK: - update-issue state

    @Test("The sheet's state reaches the payload as an open/close transition")
    func updateIssueStateMapping() {
        #expect(UpdateIssueSheet.stateChange(for: "closed") == .close)
        #expect(UpdateIssueSheet.stateChange(for: "close") == .close)
        #expect(UpdateIssueSheet.stateChange(for: "opened") == .reopen)
        #expect(UpdateIssueSheet.stateChange(for: "open") == .reopen)
        #expect(UpdateIssueSheet.stateChange(for: nil) == nil)
        #expect(UpdateIssueSheet.stateChange(for: "weird") == nil)
    }

    // MARK: - Review diff includes untracked files

    @Test("A new-file diff keeps content exactly, including the final newline")
    func newFileDiffShape() {
        let d = RepoManager.newFileDiff(path: "a/b.txt", contents: Data("one\n++two\n".utf8))
        #expect(d.contains("--- /dev/null\n+++ b/a/b.txt\n@@ -0,0 +1,2 @@\n+one\n+++two\n"))
        #expect(!d.contains("No newline"))
        let noNL = RepoManager.newFileDiff(path: "x", contents: Data("tail".utf8))
        #expect(noNL.hasSuffix("+tail\n\\ No newline at end of file\n"))
        let binary = RepoManager.newFileDiff(path: "img.png", contents: Data([0xFF, 0xFE, 0x00]))
        #expect(binary.contains("+++ b/img.png") && binary.contains("not shown"))
    }

    @Test("Untracked rendering is bounded: past the budget files are listed, not read")
    func newFileDiffsBudget() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nfd-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let count = RepoManager.maxRenderedNewFiles + 5
        var paths: [String] = []
        for i in 0..<count {
            let name = "f\(i).txt"
            try "x\n".write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
            paths.append(name)
        }
        let diffs = RepoManager.newFileDiffs(paths: paths, in: dir)
        #expect(diffs.count == count)                                   // every file listed
        #expect(diffs[0].contains("+x"))                                 // within budget: content
        #expect(diffs[count - 1].contains("not shown"))                  // past it: header only
    }

    @Test("diff(at:) lists untracked files the workflow's `git add -A` would commit")
    func diffIncludesUntracked() async throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("wfdiff-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        func git(_ args: String...) throws {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = ["-C", repo.path] + args
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try p.run(); p.waitUntilExit()
        }
        try git("init", "-q")
        try "ignored.log\n".write(to: repo.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
        try "SECRET=1\n".write(to: repo.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
        try "noise\n".write(to: repo.appendingPathComponent("ignored.log"), atomically: true, encoding: .utf8)

        let diff = try await RepoManager().diff(at: repo)
        // Regression: untracked files never appeared in Review, yet were committed.
        #expect(diff.contains("+++ b/.env"))
        #expect(diff.contains("+SECRET=1"))
        #expect(diff.contains("+++ b/.gitignore"))
        #expect(!diff.contains("ignored.log\n+noise"), "gitignored files are not committed, so not listed")
    }
}

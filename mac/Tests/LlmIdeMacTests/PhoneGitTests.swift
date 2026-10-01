import XCTest
import SharedProtocol
@testable import LlmIdeMacLib

/// Runs against a REAL temporary git repository, so the exact command lines PhoneGit uses are exercised.
final class PhoneGitTests: XCTestCase {
    private var root: URL!

    private func git(_ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = args
        p.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["GIT_CONFIG_GLOBAL"] = "/dev/null"; env["GIT_CONFIG_SYSTEM"] = "/dev/null"
        env["GIT_AUTHOR_NAME"] = "T"; env["GIT_AUTHOR_EMAIL"] = "t@example.com"
        env["GIT_COMMITTER_NAME"] = "T"; env["GIT_COMMITTER_EMAIL"] = "t@example.com"
        p.environment = env
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    private var run: GitRun {
        let root = self.root!
        return { args in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = args
            p.currentDirectoryURL = root
            var env = ProcessInfo.processInfo.environment
            env["GIT_CONFIG_GLOBAL"] = "/dev/null"; env["GIT_CONFIG_SYSTEM"] = "/dev/null"
            p.environment = env
            let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
            try p.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            if p.terminationStatus != 0 { throw NSError(domain: "git", code: Int(p.terminationStatus)) }
            return String(decoding: data, as: UTF8.self)
        }
    }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("phonegit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        _ = try git(["init", "-q", "-b", "main"])
        try "one\n".write(to: root.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        _ = try git(["add", "."]); _ = try git(["commit", "-q", "-m", "first commit"])
        try "one\ntwo\n".write(to: root.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)          // modified
        try "fresh\n".write(to: root.appendingPathComponent("new.txt"), atomically: true, encoding: .utf8)             // untracked
        try "TOKEN=abc\n".write(to: root.appendingPathComponent(".env"), atomically: true, encoding: .utf8)            // secret
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    func testStateListsBranchChangesAndCommits() async {
        let state = await PhoneGit.state(hasGitDir: true, run: run)
        XCTAssertTrue(state.isRepo)
        XCTAssertEqual(state.branch, "main")
        XCTAssertFalse(state.hasUpstream)
        XCTAssertTrue(state.files.contains { $0.path == "a.txt" && $0.status == "modified" })
        XCTAssertTrue(state.files.contains { $0.path == "new.txt" && $0.status == "untracked" })
        XCTAssertEqual(state.commits.first?.subject, "first commit")
    }

    func testNotARepoIsReportedNotAnError() async {
        let state = await PhoneGit.state(hasGitDir: false, run: run)
        XCTAssertFalse(state.isRepo)
        XCTAssertNil(state.error)
    }

    func testDiffOfAModifiedFile() async {
        let r = await PhoneGit.diff(path: "a.txt", staged: false, root: root, run: run)
        XCTAssertNil(r.error)
        XCTAssertTrue(r.diff?.contains("+two") == true)
    }

    func testUntrackedFileIsShownAsAllAdded() async {
        let r = await PhoneGit.diff(path: "new.txt", staged: false, root: root, run: run)
        XCTAssertTrue(r.diff?.contains("+fresh") == true)
    }

    func testSecretsAndUnlistedPathsAreRefusedBeforeAnyGitDiffRuns() async {
        let secret = await PhoneGit.diff(path: ".env", staged: false, root: root, run: run)
        XCTAssertNil(secret.diff)
        XCTAssertTrue(secret.error?.contains("secrets") == true)
        for bad in ["../outside.txt", "/etc/passwd", "--output=/tmp/x", "does-not-exist.txt"] {
            let r = await PhoneGit.diff(path: bad, staged: false, root: root, run: run)
            XCTAssertNil(r.diff, bad)
            XCTAssertNotNil(r.error, bad)
        }
    }

    func testStagedFlagMustMatchTheStatusEntry() async {
        let wrong = await PhoneGit.diff(path: "a.txt", staged: true, root: root, run: run)
        XCTAssertNotNil(wrong.error, "a.txt has no staged change")
    }

    func testStateShapingCapsFilesAndCommits() {
        let changes = (0..<500).map { FileChange(path: "f\($0).txt", status: .modified, staged: false) }
        let commits = (0..<100).map { Commit(sha: "s\($0)", shortSha: "s", author: "a", relativeDate: "now", subject: "x") }
        let s = PhoneGit.shape(changes: changes, branch: "main", ahead: 0, behind: 0, hasUpstream: false, commits: commits)
        XCTAssertEqual(s.files.count, PhoneGit.maxFiles)
        XCTAssertTrue(s.filesTruncated)
        XCTAssertEqual(s.commits.count, PhoneGit.maxCommits)
    }
}

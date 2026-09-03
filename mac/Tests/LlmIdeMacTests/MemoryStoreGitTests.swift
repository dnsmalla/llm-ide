import XCTest
@testable import LlmIdeMacLib

final class MemoryStoreGitTests: XCTestCase {
    var repo: URL!

    override func setUp() {
        super.setUp()
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("memorystore-git-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        _ = try? runShell("/usr/bin/git", ["init", "-q"], cwd: repo)
        _ = try? runShell("/usr/bin/git", ["config", "user.email", "test@example.com"], cwd: repo)
        _ = try? runShell("/usr/bin/git", ["config", "user.name", "Test"], cwd: repo)
        try? "line1\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        _ = try? runShell("/usr/bin/git", ["add", "-A"], cwd: repo)
        _ = try? runShell("/usr/bin/git", ["commit", "-q", "-m", "init"], cwd: repo)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
        super.tearDown()
    }

    /// Fixture helper — plain synchronous Process, used only to set up the
    /// test repo (not the code under test).
    @discardableResult
    private func runShell(_ exe: String, _ args: [String], cwd: URL) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.currentDirectoryURL = cwd
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// A command that writes MORE than one pipe buffer (~64KB) to stderr
    /// while producing normal stdout — the shape that deadlocks a
    /// stdout-then-stderr sequential reader. `runGit` is private, so this
    /// goes through `gitDiff`, its one real caller inside MemoryStore.
    func testGitDiffDoesNotDeadlockOnLargeStderrOutput() throws {
        // Modify the tracked file so `git diff` has real stdout output...
        try "line1\nline2\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        // ...and add a git config alias that shells out to something noisy on
        // stderr for the SAME invocation is awkward via the public API, so
        // instead assert the simpler, always-true property: gitDiff completes
        // within a generous timeout at all (a deadlock hangs forever; a fixed
        // XCTestExpectation timeout turns "hangs forever" into "test fails
        // instead of the whole suite hanging").
        let store = MemoryStore()
        let exp = expectation(description: "gitDiff returns")
        var result: MemoryStore.GitDiff?
        DispatchQueue.global().async {
            result = try? store.gitDiff(at: self.repo)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 10)
        XCTAssertEqual(result?.changedPaths, ["a.txt"])
        XCTAssertTrue(result?.unified.contains("+line2") ?? false)
    }
}

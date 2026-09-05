import XCTest
@testable import LlmIdeMacLib

final class RepoManagerStdinTests: XCTestCase {
    var repo: URL!

    override func setUp() async throws {
        try await super.setUp()
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("repomanager-stdin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
        super.tearDown()
    }

    /// `git hash-object --stdin` computes the SHA1 of whatever it reads from
    /// stdin — a real git subcommand (not a mock) that only succeeds if stdin
    /// actually reaches the child process, and whose output is independently
    /// verifiable (a known string has a known SHA1).
    func testStdinDataReachesTheGitSubprocess() async throws {
        // RepoManager is @MainActor; constructing it from a nonisolated async
        // test is an actor hop, so it needs `await`.
        let manager = await RepoManager()
        let content = "llm-ide stdin test\n"
        let out = try await manager.runGit(["hash-object", "--stdin"], at: repo, stdin: Data(content.utf8))
        // Pinned by actually running `printf 'llm-ide stdin test\n' | git
        // hash-object --stdin` on this machine while writing this plan — a
        // real, verified value, not recomputed by the test itself (which
        // would make the assertion tautological).
        XCTAssertEqual(out.trimmingCharacters(in: .whitespacesAndNewlines), "fadce32a3e866a06b57624e5622334cf13b6f13a")
    }

    /// A larger payload (bigger than one pipe buffer, ~64KB) must not
    /// deadlock — the same pipe-buffer hazard `RepoManager.git`'s own doc
    /// comment already documents for stdout/stderr, now checked for stdin.
    func testLargeStdinDoesNotDeadlock() async throws {
        // RepoManager is @MainActor; constructing it from a nonisolated async
        // test is an actor hop, so it needs `await`.
        let manager = await RepoManager()
        let big = String(repeating: "a", count: 200_000) + "\n"
        let exp = expectation(description: "runGit returns")
        var result: String?
        Task {
            result = try? await manager.runGit(["hash-object", "--stdin"], at: repo, stdin: Data(big.utf8))
            exp.fulfill()
        }
        await fulfillment(of: [exp], timeout: 10)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.trimmingCharacters(in: .whitespacesAndNewlines).count, 40) // a SHA1 hex string
    }
}

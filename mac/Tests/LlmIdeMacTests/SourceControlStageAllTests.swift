import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceControlStageAllTests: XCTestCase {
    private var repoRoot: URL!
    private let repo = RepoManager()
    private var scm: SourceControlService!

    override func setUp() async throws {
        try await super.setUp()
        repoRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("scm-stage-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repoRoot, withIntermediateDirectories: true)
        _ = try await repo.runGit(["init"], at: repoRoot)
        _ = try? await repo.runGit(["config", "user.email", "test@example.com"], at: repoRoot)
        _ = try? await repo.runGit(["config", "user.name", "Test"], at: repoRoot)
        scm = SourceControlService(repo: repo)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: repoRoot)
        try await super.tearDown()
    }

    /// Verifies the EXISTING stageAll path (spec: "verify Stage All").
    func testStageAllStagesEveryChange() async throws {
        try "hello".write(to: repoRoot.appendingPathComponent("a.txt"),
                          atomically: true, encoding: .utf8)
        await scm.stageAll(root: repoRoot)
        await scm.refresh(root: repoRoot)
        XCTAssertEqual(scm.stagedFiles.count, 1)
        XCTAssertEqual(scm.unstagedFiles.count, 0)
    }

    /// Drives the NEW unstageAll path. `git reset` unstages the whole index
    /// (working tree untouched); the file drops back to untracked/unstaged.
    func testUnstageAllClearsTheIndex() async throws {
        try "hello".write(to: repoRoot.appendingPathComponent("a.txt"),
                          atomically: true, encoding: .utf8)
        await scm.stageAll(root: repoRoot)
        await scm.refresh(root: repoRoot)
        XCTAssertEqual(scm.stagedFiles.count, 1)

        await scm.unstageAll(root: repoRoot)
        await scm.refresh(root: repoRoot)
        XCTAssertEqual(scm.stagedFiles.count, 0)
        XCTAssertEqual(scm.unstagedFiles.count, 1)
    }
}

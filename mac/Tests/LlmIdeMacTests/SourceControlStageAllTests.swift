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

@MainActor
final class SourceControlSafetyTests: XCTestCase {
    private var rootA: URL!
    private var rootB: URL!
    private let repo = RepoManager()
    private var scm: SourceControlService!

    private func makeRepo() async throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scm-safety-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        _ = try await repo.runGit(["init"], at: url)
        return url
    }

    override func setUp() async throws {
        try await super.setUp()
        rootA = try await makeRepo()
        rootB = try await makeRepo()
        scm = SourceControlService(repo: repo)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: rootA)
        try? FileManager.default.removeItem(at: rootB)
        try await super.tearDown()
    }

    /// After switching to B, an action carrying A's root must not touch A.
    func testActionWithStaleRootIsRefused() async throws {
        try "x".write(to: rootA.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        await scm.refresh(root: rootA)
        await scm.refresh(root: rootB)
        await scm.stageAll(root: rootA)
        XCTAssertNotNil(scm.state.opError)
        let staged = try await repo.runGit(["diff", "--cached", "--name-only"], at: rootA)
        XCTAssertTrue(staged.isEmpty)
    }

    func testActionAfterProjectClosedIsRefused() async throws {
        await scm.refresh(root: rootA)
        await scm.refresh(root: nil)
        await scm.stageAll(root: rootA)
        XCTAssertNotNil(scm.state.opError)
    }

    /// A refresh for A that is superseded by refresh(nil) must write nothing.
    /// The hook runs after A's git calls and before its state write, so the
    /// supersession is deterministic (no reliance on scheduler timing).
    func testSupersededRefreshDoesNotOverwriteState() async throws {
        try "x".write(to: rootA.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        var fired = false
        scm.afterGitHook = { [scm = self.scm] in
            guard !fired else { return }
            fired = true
            scm?.afterGitHook = nil
            await scm?.refresh(root: nil)
        }
        await scm.refresh(root: rootA)
        XCTAssertTrue(fired)
        XCTAssertTrue(scm.state.files.isEmpty)
        XCTAssertNil(scm.state.branch)
    }

    func testRefreshIfCurrentIsNoOpWhenRootChanged() async throws {
        try "x".write(to: rootA.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        await scm.refresh(root: rootB)
        await scm.refreshIfCurrent(root: rootA)
        XCTAssertTrue(scm.state.files.isEmpty)
        // activeRoot is still B: an action on B is accepted.
        scm.clearOpError()
        await scm.stageAll(root: rootB)
        XCTAssertNil(scm.state.opError)
    }

    /// A slow action on A finishing after the switch to B must not flip the
    /// active root back to A or fill B's state with A's files.
    func testSlowActionPostRefreshDoesNotChangeActiveRoot() async throws {
        try "x".write(to: rootA.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        await scm.refresh(root: rootA)
        var switched = false
        // `rootB` is captured explicitly: an escaping closure may not use an
        // implicit `self` property.
        scm.afterGitHook = { [scm = self.scm, rootB = self.rootB] in
            guard !switched else { return }
            switched = true
            scm?.afterGitHook = nil
            await scm?.refresh(root: rootB)
        }
        // stageAll's post-action refresh for A hits the hook, which switches to B.
        await scm.stageAll(root: rootA)
        XCTAssertTrue(switched)
        XCTAssertTrue(scm.state.files.isEmpty)
        scm.clearOpError()
        await scm.stageAll(root: rootB)
        XCTAssertNil(scm.state.opError)
    }

    func testDiscardRefusesNestedGitRepo() async throws {
        let nested = rootA.appendingPathComponent("vendor")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        _ = try await repo.runGit(["init"], at: nested)
        try "y".write(to: nested.appendingPathComponent("f.txt"), atomically: true, encoding: .utf8)
        await scm.refresh(root: rootA)
        let entry = try XCTUnwrap(scm.state.files.first { $0.status == .untracked })
        await scm.discard(root: rootA, file: entry)
        XCTAssertTrue(FileManager.default.fileExists(atPath: nested.appendingPathComponent(".git").path))
        XCTAssertNotNil(scm.state.opError)
    }

    func testDiscardUntrackedFileUsesTrash() async throws {
        let file = rootA.appendingPathComponent("u.txt")
        try "z".write(to: file, atomically: true, encoding: .utf8)
        await scm.refresh(root: rootA)
        var trashed: [URL] = []
        scm.trash = { url in
            trashed.append(url)
            try FileManager.default.removeItem(at: url) // stand-in for a move
        }
        let entry = try XCTUnwrap(scm.state.files.first { $0.status == .untracked })
        await scm.discard(root: rootA, file: entry)
        XCTAssertEqual(trashed.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertNil(scm.pendingPermanentDelete)
    }

    func testFailedTrashDoesNotDeleteAndOffersPermanentDelete() async throws {
        let file = rootA.appendingPathComponent("u.txt")
        try "z".write(to: file, atomically: true, encoding: .utf8)
        await scm.refresh(root: rootA)
        scm.trash = { _ in throw CocoaError(.fileWriteUnknown) }
        let entry = try XCTUnwrap(scm.state.files.first { $0.status == .untracked })
        await scm.discard(root: rootA, file: entry)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertNotNil(scm.state.opError)
        XCTAssertNotNil(scm.pendingPermanentDelete)

        await scm.deletePermanently(root: rootA, file: entry)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertNil(scm.pendingPermanentDelete)
    }

    /// An untracked symlink to a repo directory is discardable: trashing
    /// removes only the link. A `.git` gitlink FILE is still refused.
    func testSymlinkToRepoIsDiscardableAndGitlinkFileIsRefused() async throws {
        let target = rootB // a real repo
        let link = rootA.appendingPathComponent("linked")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertFalse(SourceControlService.containsGitRepo(link))
        XCTAssertTrue(SourceControlService.containsGitRepo(target))

        let sub = rootA.appendingPathComponent("sub")
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        try "gitdir: ../elsewhere".write(to: sub.appendingPathComponent(".git"),
                                         atomically: true, encoding: .utf8)
        XCTAssertTrue(SourceControlService.containsGitRepo(sub))

        await scm.refresh(root: rootA)
        scm.trash = { url in try FileManager.default.removeItem(at: url) }
        let entry = try XCTUnwrap(scm.state.files.first { $0.path == "linked" })
        await scm.discard(root: rootA, file: entry)
        XCTAssertFalse(FileManager.default.fileExists(atPath: link.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.appendingPathComponent(".git").path))
    }
}

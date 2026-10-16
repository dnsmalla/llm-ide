import XCTest
@testable import LlmIdeMacLib

/// Pins the review fixes: a code-applying Loop stage is relaxed only for test
/// and source paths, SDK Adoption runs claim their version, and Auto Task
/// worktrees left behind by a quit or crash are cleaned at the next run.
final class AutoTaskLoopHardeningTests: XCTestCase {

    // MARK: - Protected-path relaxation

    func testCodeApplyStageIsRelaxedOnlyForTestsAndSource() {
        let apply = LoopStage(name: "Refactor Apply", kind: .skill, order: 0, skillId: "skills/refactor-apply")
        let config = LoopEngineConfig(stages: [apply], protectedPathPolicy: .revert)
        let strict = LoopEngineRunner.strictViolations(
            ["mac/Tests/A.swift", "Sources/B.swift", "Makefile", "extension/package.json",
             ".githooks/pre-push", "system/loop.json", "(unverifiable: elided)"],
            stage: apply, config: config)
        XCTAssertEqual(strict, ["Makefile", "extension/package.json", ".githooks/pre-push",
                                "system/loop.json", "(unverifiable: elided)"])
    }

    func testTestSetupMayStillEditPackageManifests() {
        let setup = LoopStage(name: "Test Setup", kind: .skill, order: 0, skillId: "skills/test-structure-setup")
        let config = LoopEngineConfig(stages: [setup], protectedPathPolicy: .revert)
        let strict = LoopEngineRunner.strictViolations(
            ["package.json", "mac/Package.swift", "pyproject.toml", "Makefile", "system/faults.csv"],
            stage: setup, config: config)
        XCTAssertEqual(strict, ["Makefile", "system/faults.csv"])
    }

    func testNonCodeApplyStageGetsNoRelaxation() {
        let docs = LoopStage(name: "Docs", kind: .skill, order: 0, skillId: "skills/doc-writer")
        let config = LoopEngineConfig(stages: [docs], protectedPathPolicy: .revert)
        let paths = ["mac/Tests/A.swift", "Makefile"]
        XCTAssertEqual(LoopEngineRunner.strictViolations(paths, stage: docs, config: config), paths)
    }

    // MARK: - SDK Adoption claim

    @MainActor
    func testSdkAdoptionClaimIsExclusiveUntilReleased() {
        let store = IncidentStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("sdk-claim-\(UUID().uuidString).json"))
        XCTAssertTrue(SdkAdoption.claim(version: "9.9.9", store: store))
        XCTAssertFalse(SdkAdoption.claim(version: "9.9.9", store: store), "a second run must not take a held version")
        SdkAdoption.release(version: "9.9.9", store: store)
        XCTAssertTrue(SdkAdoption.claim(version: "9.9.9", store: store))
        SdkAdoption.settle(version: "9.9.9", status: .fixed, note: "n", store: store)
        SdkAdoption.release(version: "9.9.9", store: store)
        XCTAssertEqual(store.incidents.first { $0.id == "sdk-adopt:9.9.9" }?.status, .fixed,
                       "release never undoes a written outcome")
        XCTAssertFalse(SdkAdoption.claim(version: "9.9.9", store: store))
    }

    func testSdkAdoptionDetectionIgnoresDisabledStages() {
        var diff = LoopStage(name: "Diff", kind: .sdkSurfaceDiff, order: 0)
        diff.enabled = false
        XCTAssertFalse(LoopStageDetector.isSdkAdoption([diff]))
        diff.enabled = true
        XCTAssertTrue(LoopStageDetector.isSdkAdoption([diff]))
    }

    // MARK: - Auto Task worktree hygiene

    func testParsesPorcelainWorktreeList() {
        let out = """
        worktree /repo
        HEAD abc
        branch refs/heads/main

        worktree /tmp/llmide-autotask/ab12cd34
        HEAD def
        branch refs/heads/fix/1-x

        worktree /tmp/llmide-autotask/ffff0000
        HEAD 123
        detached
        locked

        """
        XCTAssertEqual(AutoCodeUpdateService.parseWorktreeList(out), [
            .init(path: "/repo", branch: "main", isLocked: false),
            .init(path: "/tmp/llmide-autotask/ab12cd34", branch: "fix/1-x", isLocked: false),
            .init(path: "/tmp/llmide-autotask/ffff0000", branch: nil, isLocked: true),
        ])
    }

    func testRecognisesOnlyTheTaskWorktreeDirectory() {
        XCTAssertTrue(AutoCodeUpdateService.isTaskWorktreePath(AutoCodeUpdateService.taskWorktreePath(token: "ab12cd34")))
        XCTAssertFalse(AutoCodeUpdateService.isTaskWorktreePath("/Users/x/project"))
    }

    func testPruneRemovesAbandonedWorktreeAndParksItsCommits() throws {
        let fm = FileManager.default
        let repo = fm.temporaryDirectory.appendingPathComponent("prune-wt-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: repo) }
        func git(_ args: [String], in dir: URL) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-C", dir.path] + args
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0, "git \(args.joined(separator: " "))")
        }
        git(["init", "-q", "-b", "main"], in: repo)
        git(["config", "user.name", "t"], in: repo)
        git(["config", "user.email", "t@t"], in: repo)
        git(["config", "commit.gpgsign", "false"], in: repo)
        try "one\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        git(["add", "-A"], in: repo)
        git(["commit", "-q", "-m", "init"], in: repo)

        // Simulates a run killed mid-task: one worktree with a commit, one without.
        let committedPath = AutoCodeUpdateService.taskWorktreePath(token: AutoCodeUpdateService.shortToken())
        let emptyPath = AutoCodeUpdateService.taskWorktreePath(token: AutoCodeUpdateService.shortToken())
        XCTAssertTrue(AutoCodeUpdateService.worktreeAdd(at: repo.path, path: committedPath, branch: "fix/1-done"))
        XCTAssertTrue(AutoCodeUpdateService.worktreeAdd(at: repo.path, path: emptyPath, branch: "fix/2-empty"))
        try "two\n".write(to: URL(fileURLWithPath: committedPath).appendingPathComponent("a.txt"),
                          atomically: true, encoding: .utf8)
        XCTAssertTrue(AutoCodeUpdateService.commitAll(at: committedPath, message: "half"))

        _ = AutoCodeUpdateService.pruneStaleTaskWorktrees(at: repo.path)

        XCTAssertFalse(fm.fileExists(atPath: committedPath))
        XCTAssertFalse(fm.fileExists(atPath: emptyPath))
        XCTAssertNil(AutoCodeUpdateService.refSha("refs/heads/fix/1-done", at: repo.path))
        XCTAssertNotNil(AutoCodeUpdateService.refSha("refs/heads/autotask-wip/fix/1-done", at: repo.path),
                        "unfinished commits are parked, never deleted or left pushable")
        XCTAssertNil(AutoCodeUpdateService.refSha("refs/heads/fix/2-empty", at: repo.path))
    }
}

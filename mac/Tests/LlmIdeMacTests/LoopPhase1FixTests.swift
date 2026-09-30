import XCTest
@testable import LlmIdeMacLib

/// Phase 1 review fixes for the Loop runner (P1–P9 of the 2026-09-30 review).
/// Own stubs, so the large `LoopEngineRunnerTests` fixtures stay untouched.
@MainActor
final class LoopPhase1FixTests: XCTestCase {

    override func tearDown() {
        LoopRunQueue._resetForTesting()
        LoopWorktreeManager._resetForTesting()
        super.tearDown()
    }

    private let repoRoot = URL(fileURLWithPath: "/tmp/phase1-fix-\(UUID().uuidString)")

    // MARK: - Stubs

    final class Verifier: FaultVerifier {
        var handler: (String) -> VerifyOutcome
        init(_ handler: @escaping (String) -> VerifyOutcome) { self.handler = handler }
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            handler(command)
        }
    }

    final class Repairer: LoopStageRepairer {
        var body: () async throws -> LoopAgentResult = { LoopAgentResult() }
        private(set) var calls = 0
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL) async throws -> LoopAgentResult {
            calls += 1
            return try await body()
        }
    }

    final class SkillExecutor: LoopSkillExecuting {
        var result = LoopAgentResult()
        private(set) var calls = 0
        private(set) var extraRoots: [[URL]] = []
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL]) async throws -> LoopAgentResult {
            calls += 1
            self.extraRoots.append(extraRoots)
            return result
        }
    }

    final class Sweep: RegressionSweepRunning {
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
                   repairGuard: FaultRepairGuard?) async -> SweepOutcome {
            SweepOutcome(passed: true, total: 0, regressed: 0, unchanged: 0, repaired: 0,
                         repairFailed: 0, needsApproval: 0, failed: 0, pending: 0)
        }
    }

    final class Journal: LoopRunJournaling {
        private(set) var written: [LoopRunRecord] = []
        func write(_ record: LoopRunRecord, root: URL) -> String? { written.append(record); return nil }
        func recentRuns(root: URL, limit: Int) -> [LoopRunIndexEntry] { [] }
    }

    final class Summary: LoopRunSummaryWriting {
        func write(_ record: LoopRunRecord, root: URL) async -> LoopSummaryNoteResult {
            .written(path: "llm-doc/loop/x.md")
        }
    }

    /// Answers like git would: a probe made from a CANCELLED task fails
    /// (`.indeterminate`), which is exactly what the Stop path used to hit.
    final class CancellationSensitiveGuard: RepairScopeGuarding {
        var violation: [String]
        private(set) var reverted: [String] = []
        private(set) var checkedWhileCancelled = false
        init(violation: [String]) { self.violation = violation }
        func snapshot(gitRoot: URL, protectedGlobs: [String], scopeGlobs: [String]) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck {
            if Task.isCancelled {
                checkedWhileCancelled = true
                return .indeterminate(reason: "git status failed: cancelled")
            }
            return violation.isEmpty ? .clean(changedPaths: [])
                : .violated(paths: violation, allChangedPaths: violation)
        }
        func revert(paths: [String], gitRoot: URL) async -> String? {
            reverted.append(contentsOf: paths)
            return nil
        }
    }

    private func approvals(_ stages: [(String, String)]) -> VerifyApprovalStore {
        let store = VerifyApprovalStore(defaults: UserDefaults(suiteName: "p1fix-\(UUID().uuidString)")!)
        for (id, command) in stages { store.approveStage(repo: repoRoot, stageId: id, command: command) }
        return store
    }

    private func runner(verifier: FaultVerifier = Verifier { _ in VerifyOutcome(exitCode: 0, output: "") },
                        repairer: LoopStageRepairer = Repairer(),
                        skills: LoopSkillExecuting = SkillExecutor(),
                        approvals: VerifyApprovalStore,
                        journal: Journal = Journal(),
                        scopeGuard: RepairScopeGuarding) -> LoopEngineRunner {
        LoopEngineRunner(verifier: verifier, stageRepairer: repairer, regressionSweep: Sweep(),
                         skillExecutor: skills, approvals: approvals, stageTimeout: 600,
                         journal: journal, summaryWriter: Summary(), scopeGuard: scopeGuard,
                         transportRetryDelay: 0)
    }

    // MARK: - P2: a Stop mid-edit still runs the guard

    func testStopMidRepairStillChecksAndRevertsProtectedEdit() async {
        let started = expectation(description: "repair started")
        let repairer = Repairer()
        repairer.body = {
            started.fulfill()
            // The agent has already written the test file; the Stop lands now.
            try await Task.sleep(nanoseconds: 30_000_000_000)
            return LoopAgentResult()
        }
        let scope = CancellationSensitiveGuard(violation: ["Tests/FooTests.swift"])
        let journal = Journal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 3, protectedPathPolicy: .revert)
        let r = runner(verifier: Verifier { _ in VerifyOutcome(exitCode: 1, output: "1 failure") },
                       repairer: repairer, approvals: approvals([("t", "swift test")]),
                       journal: journal, scopeGuard: scope)
        let root = repoRoot
        let task = Task { await r.run(config: config, faultsRoot: root, gitRoot: root) }
        await fulfillment(of: [started], timeout: 10)
        task.cancel()
        let status = await task.value

        XCTAssertEqual(status, .aborted, "the cancellation still propagates")
        XCTAssertFalse(scope.checkedWhileCancelled, "the check must not run in the cancelled task")
        XCTAssertEqual(scope.reverted, ["Tests/FooTests.swift"], "the protected edit is reverted under .revert")
        let attempt = journal.written.last?.iterations.last?.attempts.last
        XCTAssertEqual(attempt?.scopeVerdict, .violatedReverted)
        XCTAssertEqual(attempt?.changedPaths, ["Tests/FooTests.swift"])
    }

    // MARK: - P1: split layout — the skill agent reaches <project>/llm-doc

    private func makeSplitProject() throws -> (project: URL, repo: URL) {
        let project = FileManager.default.temporaryDirectory
            .appendingPathComponent("p1fix-split-\(UUID().uuidString)", isDirectory: true)
        let repo = project.appendingPathComponent("code/app", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("system"),
                                                withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: project.appendingPathComponent("system/project.json"))
        addTeardownBlock { try? FileManager.default.removeItem(at: project) }
        return (project.resolvingSymlinksInPath(), repo.resolvingSymlinksInPath())
    }

    private func skillConfig() -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "plan", name: "Plan", kind: .skill, order: 0, skillId: "fam/plan")
        ], maxIterations: 1)
    }

    func testSplitLayoutSkillRunSendsTheProjectLlmDoc() async throws {
        let (project, repo) = try makeSplitProject()
        let skills = SkillExecutor()
        let r = runner(skills: skills, approvals: approvals([]), scopeGuard: CancellationSensitiveGuard(violation: []))
        _ = await r.run(config: skillConfig(), faultsRoot: project, gitRoot: repo)

        let llmDoc = project.appendingPathComponent("llm-doc", isDirectory: true)
        XCTAssertEqual(skills.extraRoots.map { $0.map(\.path) }, [[llmDoc.path]])
        XCTAssertTrue(FileManager.default.fileExists(atPath: llmDoc.path), "created when missing")
    }

    func testSkillExtraRootsOnlyForAnOutsideLlmDocOfARealProject() throws {
        let (project, repo) = try makeSplitProject()
        XCTAssertEqual(LoopEngineRunner.skillExtraRoots(projectRoot: project, gitRoot: project), [],
                       "project root IS the repo: llm-doc is already inside")
        let deep = project.appendingPathComponent("a/b/c/d")
        XCTAssertEqual(LoopEngineRunner.skillExtraRoots(projectRoot: project, gitRoot: deep), [],
                       "more than 3 levels down — the server would refuse it")
        let unrelated = FileManager.default.temporaryDirectory.appendingPathComponent("elsewhere")
        XCTAssertEqual(LoopEngineRunner.skillExtraRoots(projectRoot: project, gitRoot: unrelated), [])
        try FileManager.default.removeItem(at: project.appendingPathComponent("system/project.json"))
        XCTAssertEqual(LoopEngineRunner.skillExtraRoots(projectRoot: project, gitRoot: repo), [],
                       "not an LLM-IDE project")
    }

    func testRequestCarriesExtraRootsOnlyWhenSet() throws {
        let body = LlmIdeAPIClient.loopAgentRunRequest(
            message: "m", skills: [], repoRoot: URL(fileURLWithPath: "/tmp/p/code/app"),
            extraRoots: [URL(fileURLWithPath: "/tmp/p/llm-doc")], language: nil, model: nil, timeout: nil)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(json["extraRoots"] as? [String], ["/tmp/p/llm-doc"])
        let bare = LlmIdeAPIClient.loopAgentRunRequest(
            message: "m", skills: [], repoRoot: URL(fileURLWithPath: "/tmp/r"), language: nil, model: nil, timeout: nil)
        let bareJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(bare)) as? [String: Any])
        XCTAssertNil(bareJSON["extraRoots"])
    }

    // MARK: - P1: a skill run that did nothing it was asked to FAILS

    private func runSkill(returning result: LoopAgentResult,
                          guardChanged: [String] = []) async -> (LoopEngineStatus?, LoopStageAttempt?) {
        let skills = SkillExecutor()
        skills.result = result
        let journal = Journal()
        let scope = CancellationSensitiveGuard(violation: [])
        let r = runner(skills: skills, approvals: approvals([]), journal: journal, scopeGuard: scope)
        let status = await r.run(config: skillConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)
        return (status, journal.written.last?.iterations.last?.attempts.last)
    }

    func testSkillStageFailsWhenTheRunDidNotFinish() async {
        let (status, attempt) = await runSkill(returning: LoopAgentResult(resultSubtype: "error_max_turns"))
        guard case .error(let message)? = status else { return XCTFail("expected .error, got \(String(describing: status))") }
        XCTAssertTrue(message.contains("error_max_turns"), message)
        XCTAssertEqual(attempt?.passed, false)
        XCTAssertEqual(attempt?.agentNote, "agent run ended error_max_turns")
    }

    func testSkillStageFailsWhenItsSkillWasTruncated() async {
        let (status, attempt) = await runSkill(returning: LoopAgentResult(
            changedPaths: ["a.md"], resolvedSkills: ["fam/plan"], truncatedSkills: ["fam/plan"]))
        guard case .error(let message)? = status else { return XCTFail("expected .error") }
        XCTAssertTrue(message.contains("fam/plan"), message)
        XCTAssertEqual(attempt?.passed, false)
    }

    func testSkillStageFailsWhenEveryEditWasRefusedAndNothingChanged() async {
        let denial = LoopAgentResult.Denial(toolName: "Write", reason: "Write refused: /p/llm-doc/PLAN.md is outside")
        let (status, _) = await runSkill(returning: LoopAgentResult(denied: [denial]))
        guard case .error(let message)? = status else { return XCTFail("expected .error") }
        XCTAssertTrue(message.contains("PLAN.md is outside"), "names the first denial: \(message)")
    }

    func testSkillStageWithDenialsButRealEditsStillPasses() async {
        let denial = LoopAgentResult.Denial(toolName: "Read", reason: "Read refused: .env")
        let (status, attempt) = await runSkill(returning: LoopAgentResult(
            changedExtraPaths: ["/p/llm-doc/plans/PLAN.md"], denied: [denial]))
        XCTAssertEqual(status, .success)
        XCTAssertEqual(attempt?.passed, true)
    }

    func testRepairDenialsAndSubtypeAreRecordedButDoNotFailTheStage() async {
        var runs = 0
        let verifier = Verifier { _ in
            runs += 1
            return VerifyOutcome(exitCode: runs == 1 ? 1 : 0, output: runs == 1 ? "1 failure" : "")
        }
        let repairer = Repairer()
        repairer.body = {
            LoopAgentResult(resultSubtype: "error_max_turns",
                            denied: [.init(toolName: "Bash", reason: "Bash is not available")])
        }
        let journal = Journal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 3)
        let r = runner(verifier: verifier, repairer: repairer, approvals: approvals([("t", "swift test")]),
                       journal: journal, scopeGuard: CancellationSensitiveGuard(violation: []))
        let status = await r.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(status, .success, "the verify re-run decides, not the repair's ending")
        let repairAttempt = journal.written.last?.iterations.first?.attempts.first
        XCTAssertEqual(repairAttempt?.repairAttempted, true)
        XCTAssertEqual(repairAttempt?.agentNote,
                       "agent run ended error_max_turns; 1 tool call(s) refused, first: Bash is not available")
    }
}

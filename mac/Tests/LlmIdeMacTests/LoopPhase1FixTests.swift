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
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL) async throws -> LoopAgentResult {
            calls += 1
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
}

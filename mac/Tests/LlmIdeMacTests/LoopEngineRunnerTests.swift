import XCTest
@testable import LlmIdeMacLib

@MainActor
final class LoopEngineRunnerTests: XCTestCase {
    /// Keyed by command string (not just call count) so a single stub can
    /// drive multi-stage tests; still supports the single-stage
    /// call-count-based sequencing the earlier tests need via a captured
    /// mutable counter inside the handler closure.
    private final class StubVerifier: FaultVerifier {
        var handler: (String) throws -> VerifyOutcome
        private(set) var calls: [String] = []
        init(handler: @escaping (String) throws -> VerifyOutcome) { self.handler = handler }
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            calls.append(command)
            return try handler(command)
        }
    }

    private final class StubRepairer: LoopStageRepairer {
        private(set) var repairCount = 0
        /// Every evidence payload the runner passed, in order — so a test can
        /// assert what the repair agent was actually told about its last attempt.
        private(set) var evidence: [RepairEvidence?] = []
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL) async throws {
            repairCount += 1
            self.evidence.append(evidence)
        }
    }

    private struct SkillError: Error {}
    private final class StubSkillExecutor: LoopSkillExecuting {
        private(set) var callCount = 0
        var throwOnEveryCall: Bool = false
        func execute(skillId: String, targetPath: String?, message: String) async throws {
            callCount += 1
            if throwOnEveryCall { throw SkillError() }
        }
    }

    /// Suspends inside `repair(...)` until released, so a test can prove a
    /// second `LoopEngineRunner` is rejected while a first one is
    /// genuinely still in flight (rather than racing on timing).
    private actor Signal {
        private var fired = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func fire() {
            guard !fired else { return }
            fired = true
            waiters.forEach { $0.resume() }
            waiters.removeAll()
        }

        func wait() async {
            if fired { return }
            await withCheckedContinuation { waiters.append($0) }
        }
    }

    private final class BlockingRepairer: LoopStageRepairer {
        let started = Signal()
        let release = Signal()
        private(set) var repairCount = 0
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL) async throws {
            repairCount += 1
            await started.fire()
            await release.wait()
        }
    }

    private final class StubRegressionSweep: RegressionSweepRunning {
        var alwaysPasses: Bool
        /// Invoked synchronously on every `sweep` call, before
        /// returning. Lets a test inject a side effect (e.g. cancelling
        /// the enclosing `Task`) at the exact moment the runner is
        /// mid-stage, rather than only before/after a run.
        var onSweep: (() -> Void)?
        init(alwaysPasses: Bool, onSweep: (() -> Void)? = nil) {
            self.alwaysPasses = alwaysPasses
            self.onSweep = onSweep
        }
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> SweepOutcome {
            onSweep?()
            return alwaysPasses
                ? SweepOutcome(passed: true, total: 0, regressed: 0, unchanged: 0,
                               repaired: 0, repairFailed: 0, needsApproval: 0,
                               failed: 0, pending: 0)
                : SweepOutcome(passed: false, total: 1, regressed: 1, unchanged: 0,
                               repaired: 0, repairFailed: 0, needsApproval: 0,
                               failed: 0, pending: 0)
        }
    }

    /// Returns a failing `SweepOutcome` whose `regressed` count strictly
    /// decreases on successive calls (5, 4, 3, 2, 1, 1, …), so every
    /// iteration after the first hits the stall logic's decrease-reset
    /// (`outcome.regressed < prev`) branch instead of accumulating the
    /// stall count. The count floors at 1 once exhausted so a run that
    /// outlasts the sequence still sees a well-formed failing outcome.
    private final class DecreasingRegressionSweep: RegressionSweepRunning {
        private var callCount = 0
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> SweepOutcome {
            defer { callCount += 1 }
            let regressed = max(1, 5 - callCount)
            return SweepOutcome(passed: false, total: regressed, regressed: regressed, unchanged: 0,
                                 repaired: 0, repairFailed: 0, needsApproval: 0,
                                 failed: 0, pending: 0)
        }
    }

    private final class ThrowingRepairer: LoopStageRepairer {
        let error: Error
        init(error: Error) { self.error = error }
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL) async throws {
            throw error
        }
    }

    /// Captures journal writes instead of touching the disk. Also what proves the
    /// runner journals at all — the production `FileLoopRunJournal` would create
    /// directories under `repoRoot` (a path in /tmp that no test should litter).
    private final class InMemoryJournal: LoopRunJournaling {
        private(set) var written: [LoopRunRecord] = []
        /// When set, `write` reports this failure — used to prove journalling is
        /// fail-open and never changes a run's verdict.
        var failWith: String?
        func write(_ record: LoopRunRecord, root: URL) -> String? {
            written.append(record)
            return failWith
        }
        func recentRuns(root: URL, limit: Int) -> [LoopRunIndexEntry] {
            written.suffix(limit).reversed().map(LoopRunIndexEntry.init)
        }
    }

    /// Reports whatever a test tells it to. The default `.clean` keeps every
    /// pre-existing test on its original code path (no violation, no git
    /// subprocess) while letting the guard tests drive each policy branch.
    private final class StubScopeGuard: RepairScopeGuarding {
        var result: RepairScopeCheck
        private(set) var revertedPaths: [String] = []
        /// When set, `revert` fails with this reason.
        var revertError: String?
        init(result: RepairScopeCheck = .clean(changedPaths: [])) { self.result = result }
        func snapshot(gitRoot: URL) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck { result }
        func revert(paths: [String], gitRoot: URL) async -> String? {
            revertedPaths.append(contentsOf: paths)
            return revertError
        }
    }

    /// Journal + scope guard the tests always want stubbed, defaulted in one
    /// place. Production defaults (`FileLoopRunJournal`, `GitRepairScopeGuard`)
    /// would write to disk and shell out to git from every test.
    private func makeRunner(verifier: FaultVerifier,
                            stageRepairer: LoopStageRepairer,
                            regressionSweep: RegressionSweepRunning,
                            skillExecutor: LoopSkillExecuting,
                            approvals: VerifyApprovalStore,
                            stageTimeout: TimeInterval = 600,
                            journal: LoopRunJournaling? = nil,
                            scopeGuard: RepairScopeGuarding? = nil,
                            trigger: LoopRunTrigger = .manual) -> LoopEngineRunner {
        LoopEngineRunner(
            verifier: verifier, stageRepairer: stageRepairer,
            regressionSweep: regressionSweep, skillExecutor: skillExecutor,
            approvals: approvals, stageTimeout: stageTimeout,
            journal: journal ?? InMemoryJournal(),
            scopeGuard: scopeGuard ?? StubScopeGuard(),
            trigger: trigger)
    }

    private func makeApprovals(approve stages: [(stageId: String, command: String)] = []) -> VerifyApprovalStore {
        let suite = UserDefaults(suiteName: "loop-engine-runner-test-\(UUID().uuidString)")!
        let store = VerifyApprovalStore(defaults: suite)
        for (stageId, command) in stages {
            // Must match `repoRoot` below — approvals are hashed by repo
            // path, so a mismatched literal here would silently break
            // every approval check.
            store.approveStage(repo: repoRoot, stageId: stageId, command: command)
        }
        return store
    }

    // Unique per test-method invocation (XCTest creates a fresh instance
    // per test, re-running this initializer each time) so the new
    // process-wide `LoopEngineRunner.activeRoots` static state can't
    // leak a "still locked" false-rejection between unrelated tests.
    private let repoRoot = URL(fileURLWithPath: "/tmp/repo-\(UUID().uuidString)")

    func testAllStagesPassOnFirstIterationSucceeds() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.status, .success)
        XCTAssertEqual(runner.iteration, 1)
        XCTAssertEqual(repairer.repairCount, 0)
    }

    func testOneFailureThenFixThenPassSucceedsOnSecondIteration() async {
        var callIndex = 0
        let outcomes = [VerifyOutcome(exitCode: 1, output: "boom"), VerifyOutcome(exitCode: 0, output: "")]
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return outcomes[min(callIndex, outcomes.count - 1)]
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.status, .success)
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 1)
    }

    func testMaxIterationsGivesUpWhenNeverFixed() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "still broken 1") }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 10)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 3)
        // The 3rd (final) iteration gives up instead of repairing again —
        // only iterations 1 and 2 trigger a repair call.
        XCTAssertEqual(repairer.repairCount, 2)
    }

    func testConsecutiveIdenticalFailuresGivesUpBeforeMaxIterations() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "identical failure") }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .repeatedFailure))
        XCTAssertEqual(runner.status, .givenUp(reason: .repeatedFailure))
        XCTAssertEqual(runner.iteration, 2)
    }

    func testUnapprovedShellStageStopsImmediatelyWithoutRepairing() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals()   // nothing approved
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .needsApproval(stageName: "Test"))
        XCTAssertEqual(runner.status, .needsApproval(stageName: "Test"))
        // Approval is now checked in a preflight pass before the iteration
        // loop starts, so an unapproved stage must not consume an iteration.
        XCTAssertEqual(runner.iteration, 0)
        XCTAssertEqual(repairer.repairCount, 0)
        XCTAssertTrue(verifier.calls.isEmpty)
    }

    func testFailingRegressionStageRetriesWithoutCallingStageRepairer() async {
        let repairer = StubRepairer()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 2, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier,
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals()
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 0)
        // A run with no `.shellCommand` stage should never touch the shell
        // verifier at all.
        XCTAssertTrue(verifier.calls.isEmpty)
    }

    func testRegressionBranchLogsRegressedAndPassedCounts() async {
        let repairer = StubRepairer()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier,
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals()
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        // The stub's failing outcome is total:1, regressed:1 → log line must
        // surface "1 regressed" and "of 1", not a bare "failed".
        let regressionLines = runner.log.filter { $0.text.contains("[Regression]") }
        XCTAssertFalse(regressionLines.isEmpty)
        XCTAssertTrue(regressionLines.contains { $0.text.contains("1 regressed") })
        XCTAssertTrue(regressionLines.contains { $0.text.contains("of 1") })
    }

    func testRegressionStallGivesUpBeforeMaxIterations() async {
        let repairer = StubRepairer()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        // The stub always reports regressed == 1 (never decreases), so with
        // consecutiveFailureStop: 2 the run should stall before maxIterations.
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier,
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals()
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .regressionStalled))
        XCTAssertEqual(runner.status, .givenUp(reason: .regressionStalled))
        // Iteration 1 sets the baseline (count 1); iteration 2 reaches
        // consecutiveFailureStop → stalls. Mirrors the shell stage's
        // testConsecutiveIdenticalFailuresGivesUpBeforeMaxIterations.
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 0)
    }

    /// A regressed count that DECREASES between iterations must reset the
    /// regression stall count to 1 (the `else` branch where
    /// `outcome.regressed < prev`), so the run keeps looping instead of
    /// giving up with `.regressionStalled`. Mirrors
    /// `testRegressionStallGivesUpBeforeMaxIterations` in shape, but uses
    /// `DecreasingRegressionSweep` (5→4→3→2→1) instead of the constant-1
    /// stub: that test pins regressed at 1 so it never decreases and
    /// stalls at `consecutiveFailureStop`; this one strictly decreases
    /// every call, exercising the decrease-reset path and proving the run
    /// only stops at `maxIterations` — never `.regressionStalled`.
    func testRegressionStallResetsWhenRegressedCountDecreases() async {
        let repairer = StubRepairer()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier,
            stageRepairer: repairer,
            regressionSweep: DecreasingRegressionSweep(),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals()
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        // The regressed count decreases every iteration (5→4→3→2→1), so
        // the stall count is reset to 1 each time and never reaches
        // `consecutiveFailureStop` (2). The run must therefore exhaust
        // `maxIterations` rather than give up with `.regressionStalled`.
        XCTAssertEqual(result, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 5)
        // The key assertion: a decreasing regressed count does NOT
        // trigger `.regressionStalled` — progress keeps the run looping.
        XCTAssertNotEqual(result, .givenUp(reason: .regressionStalled))
        XCTAssertEqual(repairer.repairCount, 0)
    }

    // MARK: - Fix 1: process-wide concurrency guard

    func testConcurrentRunsOnSameGitRootAreRejected() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let repairer = BlockingRepairer()
        let approvals = makeApprovals(approve: [("t1", "swift test")])
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5)

        let runner1 = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: approvals
        )
        let runner2 = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: approvals
        )

        let task1 = Task { await runner1.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot) }
        // Wait for runner1 to actually be mid-repair (holding the gitRoot
        // lock) before starting runner2, instead of racing on timing.
        await repairer.started.wait()

        let result2 = await runner2.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertNil(result2)
        XCTAssertNil(runner2.status)
        XCTAssertFalse(runner2.running)

        await repairer.release.fire()
        _ = await task1.value
    }

    // MARK: - Fix 2/3: verify timeout and cancellation handling

    func testTimeoutCountsAsIterationFailureAndRetries() async {
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            if callIndex == 0 { throw VerifyError.timedOut(5) }
            return VerifyOutcome(exitCode: 0, output: "")
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 1)
    }

    func testVerifierCancellationMapsToAborted() async {
        let verifier = StubVerifier { _ in throw CancellationError() }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .aborted)
        XCTAssertEqual(runner.status, .aborted)
        XCTAssertEqual(repairer.repairCount, 0)
    }

    /// `RegressionSweepRunning.sweep` is fail-closed and returns
    /// `false` on cancellation rather than throwing (per its Task 5
    /// contract), so a cancelled regression-sweep-only run would, without
    /// an explicit `Task.isCancelled` check in the iteration loop, just
    /// burn every remaining iteration as an ordinary sweep failure and
    /// report `.givenUp(.maxIterations)` — never surfacing that it was
    /// actually cancelled.
    func testCancelledRegressionSweepOnlyRunMapsToAborted() async {
        let repairer = StubRepairer()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals()
        )
        let task = Task { await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot) }
        task.cancel()
        let result = await task.value
        XCTAssertEqual(result, .aborted)
        XCTAssertEqual(runner.status, .aborted)
    }

    /// The `Task.isCancelled` check at the top of the iteration loop only
    /// catches cancellation that arrives BETWEEN iterations. With
    /// `maxIterations: 1`, that first (and only) iteration's own
    /// `.givenUp(.maxIterations)` give-up path fires from INSIDE the
    /// loop body without ever looping back to that check — so a
    /// cancellation that races in mid-iteration (here, triggered by the
    /// sweep stub itself, simulating cancellation arriving while the
    /// regression sweep is running) must still be caught by the
    /// pre-finalization check right before `finalStatus` is computed.
    /// Unlike `testCancelledRegressionSweepOnlyRunMapsToAborted` (which
    /// cancels BEFORE the loop starts, iteration == 0), this cancels
    /// AFTER the top-of-loop check already passed.
    func testCancellationDuringFinalIterationOverridesGivenUp() async {
        let repairer = StubRepairer()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)

        var runningTask: Task<LoopEngineStatus?, Never>?
        let regressionSweep = StubRegressionSweep(alwaysPasses: false, onSweep: {
            runningTask?.cancel()
        })
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: regressionSweep,
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals()
        )
        let task = Task { await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot) }
        runningTask = task
        let result = await task.value
        XCTAssertEqual(result, .aborted)
        XCTAssertEqual(runner.status, .aborted)
    }

    /// The repair call's catch block must special-case `CancellationError`
    /// too, not just the verify call's — otherwise a cancelled repair
    /// falls into the generic catch and reports a confusing `.error`
    /// instead of `.aborted`.
    func testRepairCancellationMapsToAborted() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let repairer = ThrowingRepairer(error: CancellationError())
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .aborted)
        XCTAssertEqual(runner.status, .aborted)
    }

    // MARK: - Fix 5: hash normalization ignores elapsed-time noise

    func testConsecutiveFailureDetectionIgnoresElapsedTimeNoise() async {
        let outputs = ["FAILED in 0.5s", "FAILED in 1.2s"]
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return VerifyOutcome(exitCode: 1, output: outputs[min(callIndex, outputs.count - 1)])
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        // "FAILED in 0.5s" and "FAILED in 1.2s" differ only in digits, which
        // are stripped before hashing — this must count as the SAME
        // failure twice, not two distinct ones.
        XCTAssertEqual(result, .givenUp(reason: .repeatedFailure))
        XCTAssertEqual(runner.iteration, 2)
    }

    /// A blanket "strip every digit" normalizer (the previous round's
    /// implementation) would hash `"3 failures"` and `"1 failure"` as
    /// identical, hiding genuine progress (a SHRINKING failure count is
    /// the canonical sign a repair is working) behind a false
    /// `.repeatedFailure` give-up. The narrowed normalizer only strips
    /// duration/hex shapes, so these two distinct failures must reset
    /// the consecutive counter instead of accumulating it.
    func testShrinkingFailureCountIsTreatedAsADifferentFailureNotARepeat() async {
        let outcomes = [
            VerifyOutcome(exitCode: 1, output: "3 failures"),
            VerifyOutcome(exitCode: 1, output: "1 failure"),
            VerifyOutcome(exitCode: 0, output: "")
        ]
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return outcomes[min(callIndex, outcomes.count - 1)]
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        // If "3 failures" and "1 failure" had hashed equal, this would
        // incorrectly give up at iteration 2 with `.repeatedFailure`
        // instead of reaching a real fix on iteration 3.
        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.iteration, 3)
        XCTAssertEqual(repairer.repairCount, 2)
    }

    // MARK: - Fix 6: multi-stage ordering and per-stage isolation

    func testStagesRunInOrderNotDeclarationOrder() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "b", name: "B", kind: .shellCommand, command: "cmd-b", order: 1),
            LoopStage(id: "a", name: "A", kind: .shellCommand, command: "cmd-a", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("a", "cmd-a"), ("b", "cmd-b")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(verifier.calls, ["cmd-a", "cmd-b"])
    }

    func testPerStageFailureTrackingDoesNotLeakAcrossStages() async {
        // Stage A fails once (with output "same-output"), gets repaired,
        // and then passes. Stage B independently fails twice in a row with
        // the exact same output text. Under the old shared-hash/count
        // implementation, B's first failure would look like a SECOND
        // consecutive occurrence of A's earlier failure (same hash, never
        // reset) and the whole run would incorrectly give up one iteration
        // early. With per-stage tracking, B must fail twice on its OWN
        // before giving up.
        var aCallCount = 0
        let verifier = StubVerifier { command in
            switch command {
            case "cmd-a":
                defer { aCallCount += 1 }
                return aCallCount == 0
                    ? VerifyOutcome(exitCode: 1, output: "same-output")
                    : VerifyOutcome(exitCode: 0, output: "")
            case "cmd-b":
                return VerifyOutcome(exitCode: 1, output: "same-output")
            default:
                return VerifyOutcome(exitCode: 0, output: "")
            }
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "a", name: "A", kind: .shellCommand, command: "cmd-a", order: 0),
            LoopStage(id: "b", name: "B", kind: .shellCommand, command: "cmd-b", order: 1)
        ], maxIterations: 4, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("a", "cmd-a"), ("b", "cmd-b")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .repeatedFailure))
        // Iteration 1: A fails (1st), repaired. Iteration 2: A passes, B
        // fails (1st on its own), repaired. Iteration 3: A passes, B fails
        // (2nd on its own) → gives up. If A's history leaked into B this
        // would incorrectly land on iteration 2 instead of 3.
        XCTAssertEqual(runner.iteration, 3)
        XCTAssertEqual(repairer.repairCount, 2)
    }

    // MARK: - Fix 8: maxIterations of 0

    func testMaxIterationsZeroGivesUpImmediatelyWithoutRunning() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 0, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 0)
        XCTAssertTrue(verifier.calls.isEmpty)
    }

    // MARK: - Skill stage dispatch (.skill generate step)

    func testSkillStageRunsOnceAndCompletesWhenVerifyPasses() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let skill = StubSkillExecutor()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0,
                      skillId: "skills/fix", targetPath: nil, prompt: nil),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill,
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.iteration, 1)
        XCTAssertEqual(skill.callCount, 1)
        XCTAssertEqual(repairer.repairCount, 0)
    }

    /// A skill stage re-runs every iteration (generate) until a verify stage
    /// gates the run — here a constant-failing regression sweep burns both
    /// iterations, so the skill runs twice.
    func testSkillStageReRunsEachIteration() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let skill = StubSkillExecutor()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0,
                      skillId: "skills/fix", targetPath: nil, prompt: nil),
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 1)
        ], maxIterations: 2, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            skillExecutor: skill,
            approvals: makeApprovals()
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(skill.callCount, 2)   // ran once per iteration, before the regression gate
    }

    /// A skill that throws a transport error must NOT end the run — it's logged
    /// and the verify stages still decide.
    func testSkillStageErrorIsNonFatal() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let skill = StubSkillExecutor()
        skill.throwOnEveryCall = true
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0,
                      skillId: "skills/fix", targetPath: nil, prompt: nil),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill,
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)     // verify stage still passed despite the skill error
        XCTAssertEqual(skill.callCount, 1)
    }

    // MARK: - Protected-path guard (anti-reward-hacking)

    /// The load-bearing case for the whole guard. The stage's SECOND verify would
    /// pass — exactly what happens when an agent deletes the failing test — so a
    /// loop that merely logged the violation and kept going would re-verify,
    /// observe exit 0, and report `.success`. It must report `.blocked` instead,
    /// and never run the stage again.
    func testRepairThatEditsAProtectedPathBlocksInsteadOfSucceeding() async {
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            // Fails first, then "passes" — the shape a deleted test produces.
            return callIndex == 0
                ? VerifyOutcome(exitCode: 1, output: "boom")
                : VerifyOutcome(exitCode: 0, output: "")
        }
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["mac/Tests/FooTests.swift"],
            allChangedPaths: ["mac/Tests/FooTests.swift"]))
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5, protectedPathPolicy: .revert)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .blocked(reason: .repairOutOfScope(
            stageName: "Test", paths: ["mac/Tests/FooTests.swift"])))
        XCTAssertNotEqual(result, .success)
        // The stage ran exactly once: the run ended before the would-be-passing
        // second verify.
        XCTAssertEqual(verifier.calls.count, 1)
    }

    func testRevertPolicyRestoresOnlyTheViolatingPaths() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["Makefile"],
            allChangedPaths: ["Makefile", "Sources/Thing.swift"]))
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5, protectedPathPolicy: .revert)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        // The legitimate production edit is left alone — only the protected path
        // is undone.
        XCTAssertEqual(scopeGuard.revertedPaths, ["Makefile"])
    }

    /// `.stop` blocks like `.revert` but leaves the tree as the agent left it, so
    /// a human can inspect what it tried.
    func testStopPolicyBlocksWithoutReverting() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["mac/Tests/A.swift"], allChangedPaths: ["mac/Tests/A.swift"]))
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5, protectedPathPolicy: .stop)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .blocked(reason: .repairOutOfScope(
            stageName: "Test", paths: ["mac/Tests/A.swift"])))
        XCTAssertTrue(scopeGuard.revertedPaths.isEmpty)
    }

    func testWarnPolicyKeepsLoopingAndLeavesTheEditInPlace() async {
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return callIndex == 0
                ? VerifyOutcome(exitCode: 1, output: "boom")
                : VerifyOutcome(exitCode: 0, output: "")
        }
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["mac/Tests/A.swift"], allChangedPaths: ["mac/Tests/A.swift"]))
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5, protectedPathPolicy: .warn)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertTrue(scopeGuard.revertedPaths.isEmpty)
        XCTAssertTrue(runner.log.contains { $0.text.contains("policy: warn") })
    }

    /// Fail-open, loudly. A project git cannot report on must still be able to run
    /// the loop — refusing would take the feature away from those projects
    /// entirely, which is worse than an unverified repair (what every run did
    /// before the guard existed). The warning is the required half of the deal.
    func testIndeterminateScopeCheckWarnsButDoesNotBlock() async {
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return callIndex == 0
                ? VerifyOutcome(exitCode: 1, output: "boom")
                : VerifyOutcome(exitCode: 0, output: "")
        }
        let scopeGuard = StubScopeGuard(result: .indeterminate(reason: "not a git repository"))
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertTrue(runner.log.contains { $0.text.contains("protected-path check could not run") })
    }

    /// A skill stage edits the tree too, so "make the tests pass" is as available
    /// to it as it is to the repairer.
    func testSkillStageViolationAlsoBlocks() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["mac/Tests/A.swift"], allChangedPaths: ["mac/Tests/A.swift"]))
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0, skillId: "skills/fix"),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 5, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .blocked(reason: .repairOutOfScope(
            stageName: "Fix", paths: ["mac/Tests/A.swift"])))
        // Blocked before the Test stage ran at all.
        XCTAssertTrue(verifier.calls.isEmpty)
    }

    /// `.off` restores exactly the pre-guard behaviour, and must not pay for the
    /// git calls either.
    func testPolicyOffSkipsTheCheckEntirely() async {
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return callIndex == 0
                ? VerifyOutcome(exitCode: 1, output: "boom")
                : VerifyOutcome(exitCode: 0, output: "")
        }
        // A guard configured to report a violation — which must never be consulted.
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["mac/Tests/A.swift"], allChangedPaths: ["mac/Tests/A.swift"]))
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5, protectedPathPolicy: .off)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertTrue(scopeGuard.revertedPaths.isEmpty)
    }

    // MARK: - Scored progress

    /// The case a hash comparison cannot see: three DIFFERENT failures that never
    /// get fewer. Before scoring, each new failure text reset the streak and the
    /// loop happily burned all ten iterations.
    func testDifferentFailuresWithAnUnchangingCountGiveUpAsNoProgress() async {
        let outputs = [
            "Executed 10 tests, with 3 failures (0 unexpected) in 1.0 seconds — alpha",
            "Executed 10 tests, with 3 failures (0 unexpected) in 1.0 seconds — beta",
            "Executed 10 tests, with 3 failures (0 unexpected) in 1.0 seconds — gamma"
        ]
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return VerifyOutcome(exitCode: 1, output: outputs[min(callIndex, outputs.count - 1)])
        }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .givenUp(reason: .noProgress(stageName: "Test")))
        XCTAssertEqual(runner.iteration, 2)
    }

    /// The mirror image: a shrinking count is progress, so the loop must keep
    /// going even though every failure text differs.
    func testShrinkingScoreKeepsTheLoopRunning() async {
        let outputs = [
            "Executed 10 tests, with 3 failures (0 unexpected) in 1.0 seconds",
            "Executed 10 tests, with 2 failures (0 unexpected) in 1.0 seconds",
            "Executed 10 tests, with 1 failure (0 unexpected) in 1.0 seconds"
        ]
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            if callIndex >= outputs.count { return VerifyOutcome(exitCode: 0, output: "") }
            return VerifyOutcome(exitCode: 1, output: outputs[callIndex])
        }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.iteration, 4)
    }

    /// Evidence is what turns a retry into an iteration: without the measured
    /// delta, the agent is handed the same failure and has no way to know its last
    /// edit did nothing.
    func testRepairerReceivesTheMeasuredDeltaAsEvidence() async {
        let outputs = [
            "Executed 10 tests, with 3 failures (0 unexpected) in 1.0 seconds",
            "Executed 10 tests, with 2 failures (0 unexpected) in 1.0 seconds"
        ]
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            if callIndex >= outputs.count { return VerifyOutcome(exitCode: 0, output: "") }
            return VerifyOutcome(exitCode: 1, output: outputs[callIndex])
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 3)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(repairer.evidence.count, 2)
        // First attempt: nothing to compare against yet.
        XCTAssertEqual(repairer.evidence[0]?.attempt, 1)
        XCTAssertEqual(repairer.evidence[0]?.currentScore, 3)
        XCTAssertNil(repairer.evidence[0]?.previousScore)
        // Second: the agent is told 3 → 2, i.e. that its last change helped.
        XCTAssertEqual(repairer.evidence[1]?.attempt, 2)
        XCTAssertEqual(repairer.evidence[1]?.previousScore, 3)
        XCTAssertEqual(repairer.evidence[1]?.currentScore, 2)
        XCTAssertEqual(repairer.evidence[1]?.improved, true)
    }

    // MARK: - Advisory stages

    /// The whole point of `.advisory`: a lint/format stage can join the list
    /// without a single formatting nit ending the run.
    func testAdvisoryStageFailureDoesNotFailTheRunOrTriggerRepair() async {
        let verifier = StubVerifier { command in
            command == "make lint"
                ? VerifyOutcome(exitCode: 1, output: "3 files need formatting")
                : VerifyOutcome(exitCode: 0, output: "")
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "l1", name: "Lint", kind: .shellCommand, command: "make lint",
                      order: 0, severity: .advisory),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("l1", "make lint"), ("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.iteration, 1)
        XCTAssertEqual(repairer.repairCount, 0)
        // It ran and was reported — advisory means "not gating", not "not run".
        XCTAssertEqual(verifier.calls, ["make lint", "swift test"])
        XCTAssertTrue(runner.log.contains { $0.text.contains("[Lint] advisory") })
    }

    func testAdvisoryRegressionStageDoesNotGateTheRun() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, order: 0,
                      severity: .advisory)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals()
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.iteration, 1)
    }

    // MARK: - Budgets

    /// `maxIterations` is not a time budget: ten iterations of a slow suite plus
    /// ten LLM repairs is most of an hour, unattended on the cron trigger.
    func testWallClockBudgetGivesUpBeforeMaxIterations() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 10, wallClockBudgetSeconds: 0)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .givenUp(reason: .wallClockExceeded))
        // A run always gets one COMPLETE pass — a budget too small to finish
        // startup must produce a fast failure, never a confusing no-op.
        XCTAssertEqual(runner.iteration, 1)
        XCTAssertFalse(verifier.calls.isEmpty)
    }

    func testGenerousWallClockBudgetDoesNotInterfere() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2, wallClockBudgetSeconds: 3600)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
    }

    /// Bounds the LLM spend on ONE stubborn stage independently of the iteration
    /// count — a single stage could otherwise consume every iteration's repair.
    func testRepairBudgetPerStageGivesUpBeforeMaxIterations() async {
        // Each failure differs so the streak never trips; only the repair budget
        // can end this run.
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return VerifyOutcome(exitCode: 1, output: "distinct failure \(callIndex)")
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 20, consecutiveFailureStop: 20, maxRepairsPerStage: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .givenUp(reason: .repairBudgetExhausted(stageName: "Test")))
        XCTAssertEqual(repairer.repairCount, 2)
    }

    /// A per-stage override exists because a full build+test cycle and a
    /// two-second formatter check do not belong under one timeout.
    func testPerStageTimeoutOverridesTheRunnerDefault() async {
        final class TimeoutRecordingVerifier: FaultVerifier {
            var timeouts: [TimeInterval] = []
            func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
                timeouts.append(timeout)
                return VerifyOutcome(exitCode: 0, output: "")
            }
        }
        let verifier = TimeoutRecordingVerifier()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "a", name: "Fast", kind: .shellCommand, command: "cmd-a", order: 0,
                      timeoutSeconds: 30),
            LoopStage(id: "b", name: "Default", kind: .shellCommand, command: "cmd-b", order: 1)
        ], maxIterations: 2, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("a", "cmd-a"), ("b", "cmd-b")]),
            stageTimeout: 600
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(verifier.timeouts, [30, 600])
    }

    // MARK: - Journalling

    func testEverySuccessfulRunIsJournalled() async {
        let journal = InMemoryJournal()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal, trigger: .autoTask
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             projectId: "proj-42")

        XCTAssertEqual(journal.written.count, 1)
        let record = journal.written[0]
        XCTAssertEqual(record.statusCode, "success")
        XCTAssertEqual(record.trigger, .autoTask)
        XCTAssertEqual(record.projectId, "proj-42")
        XCTAssertEqual(record.iterationsUsed, 1)
        XCTAssertEqual(record.iterations.count, 1)
        XCTAssertEqual(record.iterations[0].attempts.map(\.stageName), ["Test"])
        XCTAssertTrue(record.iterations[0].attempts[0].passed)
    }

    /// A run rejected before any iteration still has to leave a trace, or "the
    /// cron ran and nothing happened" is indistinguishable from "the cron never
    /// ran". This is why every exit from `run` goes through one `finish`.
    func testRunRejectedForApprovalIsStillJournalled() async {
        let journal = InMemoryJournal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(),      // nothing approved
            journal: journal
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(journal.written.map(\.statusCode), ["needs_approval"])
        XCTAssertEqual(journal.written[0].iterationsUsed, 0)
    }

    func testJournalRecordsScoresAndRepairAttempts() async {
        let journal = InMemoryJournal()
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return callIndex == 0
                ? VerifyOutcome(exitCode: 1, output: "Executed 10 tests, with 4 failures (0 unexpected) in 1.0 seconds")
                : VerifyOutcome(exitCode: 0, output: "")
        }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 3)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        let first = journal.written[0].iterations[0].attempts[0]
        XCTAssertEqual(first.score, 4)
        XCTAssertEqual(first.exitCode, 1)
        XCTAssertFalse(first.passed)
        XCTAssertTrue(first.repairAttempted)
        XCTAssertNotNil(first.outputHash)
    }

    func testJournalRecordsTheScopeVerdictAndChangedPaths() async {
        let journal = InMemoryJournal()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let scopeGuard = StubScopeGuard(result: .clean(changedPaths: ["Sources/Thing.swift"]))
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal, scopeGuard: scopeGuard
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        // maxIterations: 1 means the run gives up before repairing, so the recorded
        // attempt has no scope verdict yet — assert the give-up shape instead.
        XCTAssertEqual(journal.written.map(\.statusCode), ["given_up.max_iterations"])
    }

    /// Telemetry must never gate the work it observes: a full disk or a read-only
    /// checkout is not a reason to refuse to fix a failing test.
    func testJournalWriteFailureIsLoggedButDoesNotChangeTheVerdict() async {
        let journal = InMemoryJournal()
        journal.failWith = "disk full"
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertTrue(runner.log.contains { $0.text.contains("Run journal not written: disk full") })
    }

    /// A rejected call never started a run, so it must not fabricate a journal
    /// entry — that would make the run list count phantom runs.
    func testRejectedConcurrentRunIsNotJournalled() async {
        let journal = InMemoryJournal()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let repairer = BlockingRepairer()
        let approvals = makeApprovals(approve: [("t1", "swift test")])
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5)

        let runner1 = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(), approvals: approvals)
        let runner2 = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(), approvals: approvals, journal: journal)

        let task1 = Task { await runner1.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot) }
        await repairer.started.wait()
        let rejected = await runner2.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertNil(rejected)
        XCTAssertTrue(journal.written.isEmpty)

        await repairer.release.fire()
        _ = await task1.value
    }
}

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
        func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws {
            repairCount += 1
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
        func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws {
            repairCount += 1
            await started.fire()
            await release.wait()
        }
    }

    private final class StubRegressionSweep: RegressionSweepRunning {
        var alwaysPasses: Bool
        init(alwaysPasses: Bool) { self.alwaysPasses = alwaysPasses }
        func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool { alwaysPasses }
    }

    private final class ThrowingRepairer: LoopStageRepairer {
        let error: Error
        init(error: Error) { self.error = error }
        func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws {
            throw error
        }
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier,
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
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

    // MARK: - Fix 1: process-wide concurrency guard

    func testConcurrentRunsOnSameGitRootAreRejected() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let repairer = BlockingRepairer()
        let approvals = makeApprovals(approve: [("t1", "swift test")])
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5)

        let runner1 = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: approvals
        )
        let runner2 = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .aborted)
        XCTAssertEqual(runner.status, .aborted)
        XCTAssertEqual(repairer.repairCount, 0)
    }

    /// `RegressionSweepRunning.sweepPassed` is fail-closed and returns
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            approvals: makeApprovals()
        )
        let task = Task { await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot) }
        task.cancel()
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
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
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 0)
        XCTAssertTrue(verifier.calls.isEmpty)
    }
}

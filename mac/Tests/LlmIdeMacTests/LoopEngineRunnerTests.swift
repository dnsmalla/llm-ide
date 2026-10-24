import XCTest
@testable import LlmIdeMacLib

@MainActor
final class LoopEngineRunnerTests: XCTestCase {

    override func tearDown() {
        LoopRunQueue._resetForTesting()
        LoopWorktreeManager._resetForTesting()
        super.tearDown()
    }

    /// Keyed by command string (not just call count) so a single stub can
    /// drive multi-stage tests; still supports the single-stage
    /// call-count-based sequencing the earlier tests need via a captured
    /// mutable counter inside the handler closure.
    private final class StubVerifier: FaultVerifier {
        let handler: (String) throws -> VerifyOutcome
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
        /// Every `failureOutput` string the runner passed, in order — lets a
        /// test assert on the composed text itself (e.g. whether goal/
        /// acceptance context was prepended) rather than just the call count.
        private(set) var receivedFailureOutputs: [String] = []
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
            repairCount += 1
            self.evidence.append(evidence)
            receivedFailureOutputs.append(failureOutput)
            return LoopAgentResult()
        }
    }

    private struct SkillError: Error {}
    private final class StubSkillExecutor: LoopSkillExecuting {
        private(set) var callCount = 0
        var throwOnEveryCall: Bool = false
        /// Thrown one per call, in order, before `throwOnEveryCall` applies.
        var queuedErrors: [Error] = []
        /// What `throwOnEveryCall` throws.
        var everyCallError: Error = SkillError()
        /// Every `message` string the runner passed, in order — lets a test
        /// assert on the composed text itself (e.g. whether goal/acceptance
        /// context was prepended) rather than just the call count.
        private(set) var receivedMessages: [String] = []
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
            callCount += 1
            receivedMessages.append(message)
            if !queuedErrors.isEmpty { throw queuedErrors.removeFirst() }
            if throwOnEveryCall { throw everyCallError }
            return LoopAgentResult()
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
                    evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
            repairCount += 1
            await started.fire()
            await release.wait()
            return LoopAgentResult()
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
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
                   repairGuard: FaultRepairGuard?) async -> SweepOutcome {
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
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
                   repairGuard: FaultRepairGuard?) async -> SweepOutcome {
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
                    evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
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

    /// Captures summary-note writes. Production is `NoteLoopRunSummaryWriter`,
    /// which would touch the Library index and the disk from every test.
    private final class StubSummaryWriter: LoopRunSummaryWriting {
        private(set) var written: [LoopRunRecord] = []
        var result: LoopSummaryNoteResult = .written(path: "llm-doc/loop/2026/08/loop-x.md")
        func write(_ record: LoopRunRecord, root: URL) async -> LoopSummaryNoteResult {
            written.append(record)
            return result
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
        /// Paths the snapshot reports as already dirty before the edit.
        var dirtyBefore: Set<String> = []
        private(set) var checkCount = 0
        init(result: RepairScopeCheck = .clean(changedPaths: [])) { self.result = result }
        func snapshot(gitRoot: URL, protectedGlobs: [String],
                      scopeGlobs: [String]) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: dirtyBefore, usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck {
            checkCount += 1
            return result
        }
        func revert(paths: [String], gitRoot: URL) async -> String? {
            revertedPaths.append(contentsOf: paths)
            // A reverted path is clean on the next check (the post-throw re-check).
            if revertError == nil, case .violated(let bad, let all) = result {
                let left = bad.filter { !paths.contains($0) }
                result = left.isEmpty ? .clean(changedPaths: all.filter { !paths.contains($0) })
                                      : .violated(paths: left, allChangedPaths: all)
            }
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
                            summaryWriter: LoopRunSummaryWriting? = nil,
                            scopeGuard: RepairScopeGuarding? = nil,
                            trigger: LoopRunTrigger = .manual,
                            graphRescanner: GraphRescanning? = nil) -> LoopEngineRunner {
        LoopEngineRunner(
            verifier: verifier, stageRepairer: stageRepairer,
            regressionSweep: regressionSweep, skillExecutor: skillExecutor,
            approvals: approvals, stageTimeout: stageTimeout,
            journal: journal ?? InMemoryJournal(),
            summaryWriter: summaryWriter ?? StubSummaryWriter(),
            scopeGuard: scopeGuard ?? StubScopeGuard(),
            trigger: trigger,
            transportRetryDelay: 0,
            graphRescanner: graphRescanner)
    }

    private final class StubRescanner: GraphRescanning {
        func rescan(repoRoot: URL) async -> GraphRescanOutcome { .rewritten }
    }

    /// The rescanner is optional: a runner built without one has none, and
    /// one built with one keeps that exact instance for its stages to use.
    func testGraphRescannerDefaultsToNilAndIsKeptWhenGiven() {
        let common = (verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
                      repairer: StubRepairer(), sweep: StubRegressionSweep(alwaysPasses: true),
                      skills: StubSkillExecutor())
        let bare = makeRunner(verifier: common.verifier, stageRepairer: common.repairer,
                              regressionSweep: common.sweep, skillExecutor: common.skills,
                              approvals: makeApprovals())
        XCTAssertNil(bare.graphRescanner)

        let rescanner = StubRescanner()
        let wired = makeRunner(verifier: common.verifier, stageRepairer: common.repairer,
                               regressionSweep: common.sweep, skillExecutor: common.skills,
                               approvals: makeApprovals(), graphRescanner: rescanner)
        XCTAssertTrue(wired.graphRescanner === rescanner)
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
    // per test, re-running this initializer each time) so the process-wide
    // `LoopRunQueue` state can't leak a "still locked" false-rejection
    // between unrelated tests.
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

    /// `log` is instance state on a runner a view owns, so before `onLog`
    /// existed no other surface could follow a run in progress: the shared
    /// per-task buffer received only the terminal line, which is why the
    /// iPhone showed a loop as "running" with nothing to show for it.
    func testOnLogMirrorsEveryLineWhileTheRunProceeds() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        var mirrored: [String] = []
        runner.onLog = { mirrored.append($0.text) }

        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertFalse(mirrored.isEmpty, "the sink saw nothing — a watcher would show an empty log")
        // Mirrors, never diverts: the runner's own log is still complete, so
        // the page that owns it is unaffected by a watcher being attached.
        XCTAssertEqual(mirrored, runner.log.map(\.text))
    }

    func testRunWithNoLogSinkAttachedStillLogsLocally() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertFalse(runner.log.isEmpty, "an absent sink must not suppress the runner's own log")
    }

    func testOneFailureThenFixThenPassSucceedsOnSecondIteration() async {
        var callIndex = 0
        // The second failure is the flake gate's re-run: it must fail too for a
        // repair to happen.
        let outcomes = [VerifyOutcome(exitCode: 1, output: "boom"), VerifyOutcome(exitCode: 1, output: "boom"),
                        VerifyOutcome(exitCode: 0, output: "")]
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
        // Never fixed: every verify fails. Each repair + stage re-verify is one
        // iteration, so maxIterations still means maxIterations-1 repairs.
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
        // Failure + flake re-run, blind repair (iteration 2 re-verify), informed
        // repair at the first no-progress verdict (iteration 3), then give up.
        XCTAssertEqual(runner.iteration, 3)
        XCTAssertEqual(repairer.repairCount, 2)
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

    func testDisabledStageIsSkippedEntirelyIncludingPreflight() async {
        // The disabled stage's command always fails AND is unapproved — if the
        // runner ran or even preflighted it, the run could not succeed. Skipping
        // must cover both: a disabled stage takes no part in the run at all.
        let verifier = StubVerifier { command in
            command == "broken command" ? VerifyOutcome(exitCode: 1, output: "boom")
                                        : VerifyOutcome(exitCode: 0, output: "")
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "off1", name: "Broken", kind: .shellCommand,
                      command: "broken command", order: 0, enabled: false),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])   // "off1" NOT approved
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(verifier.calls, ["swift test"])
        XCTAssertEqual(repairer.repairCount, 0)
    }

    func testAllStagesDisabledFailsWithClearError() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let repairer = StubRepairer()
        let journal = InMemoryJournal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand,
                      command: "swift test", order: 0, enabled: false)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        // A run with nothing to execute must refuse loudly, not report the
        // instant hollow "success" an empty stage loop would produce.
        XCTAssertEqual(result, .error("Every stage is disabled — enable at least one"))
        XCTAssertTrue(verifier.calls.isEmpty)
        // Still journalled — a refused run the user asked for is a run outcome.
        XCTAssertEqual(journal.written.count, 1)
        XCTAssertEqual(journal.written.first?.statusCode, "error")
    }

    func testEmptyStageListFailsWithItsOwnMessage() async {
        // Distinct from all-disabled: "enable at least one" is nonsense advice
        // for a config with no stages at all.
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals()
        )
        let result = await runner.run(config: LoopEngineConfig(stages: []),
                                      faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .error("No stages configured"))
    }

    func testSkillStageWithoutSkillChosenFailsPreflight() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let skillExecutor = StubSkillExecutor()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Generate", kind: .skill, command: nil, order: 0),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skillExecutor,
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        // A generate stage with no skill would otherwise fire a bare agent
        // call with no skill framing — uncontrolled edits, every iteration.
        XCTAssertEqual(result, .error("Stage \"Generate\" has no skill chosen"))
        XCTAssertEqual(skillExecutor.callCount, 0)
        XCTAssertEqual(runner.iteration, 0)
        XCTAssertTrue(verifier.calls.isEmpty)
    }

    // MARK: - Code-applying stages need a verify stage after them

    private func refactorApplyConfig(testEnabled: Bool?) -> LoopEngineConfig {
        var stages = [LoopStage(id: "a1", name: "Refactor Apply", kind: .skill, order: 0,
                                skillId: "skills/refactor-apply")]
        if let testEnabled {
            stages.append(LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test",
                                    order: 1, enabled: testEnabled))
        }
        return LoopEngineConfig(stages: stages, maxIterations: 3, consecutiveFailureStop: 2)
    }

    private func assertRefusesUnverifiedApply(_ config: LoopEngineConfig,
                                              file: StaticString = #filePath, line: UInt = #line) async {
        let skillExecutor = StubSkillExecutor()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skillExecutor,
            approvals: makeApprovals(approve: [("t1", "swift test")]))
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        let message = "Refactor Apply needs an enabled test stage after it; skipped — nothing was edited"
        XCTAssertEqual(result, .error(message), file: file, line: line)
        XCTAssertEqual(skillExecutor.callCount, 0, "the skill executor must never be called", file: file, line: line)
        XCTAssertTrue(runner.log.contains { $0.text.contains(message) }, file: file, line: line)
        XCTAssertEqual(runner.stageStates["a1"], .failed, file: file, line: line)
    }

    /// "Run this stage only" on Refactor Apply (desktop menu / phone
    /// `loop_start_stage`) leaves nothing to verify its edits.
    func testSoloRefactorApplyIsRefusedWithoutCallingTheSkill() async throws {
        var config = refactorApplyConfig(testEnabled: true)
        config.stages = try XCTUnwrap(LoopStage.soloing(config.stages, id: "a1"))
        await assertRefusesUnverifiedApply(config)
    }

    func testRefactorApplyWithADisabledTestStageIsRefused() async {
        await assertRefusesUnverifiedApply(refactorApplyConfig(testEnabled: false))
    }

    func testRefactorApplyWithNoTestStageIsRefused() async {
        await assertRefusesUnverifiedApply(refactorApplyConfig(testEnabled: nil))
    }

    func testRefactorApplyFollowedByAnEnabledTestStageRuns() async {
        let skillExecutor = StubSkillExecutor()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skillExecutor,
            approvals: makeApprovals(approve: [("t1", "swift test")]))
        let result = await runner.run(config: refactorApplyConfig(testEnabled: true),
                                      faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(skillExecutor.callCount, 1)
        XCTAssertEqual(verifier.calls, ["swift test"])
    }

    /// A failed Test + repair, once it passes, re-runs the pipeline from the
    /// batch's first stage (here Apply, as there is no test writer) — not from
    /// the top, so the plan stage is never re-run under a half-applied batch
    /// (design doc §5.7). The apply stage must NOT run again either — that would
    /// stack the next batch onto a tree the tests have not yet proven.
    func testRetryIterationDoesNotReapplyTheCodeApplyStage() async {
        let skillExecutor = StubSkillExecutor()
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return VerifyOutcome(exitCode: callIndex < 2 ? 1 : 0, output: callIndex < 2 ? "boom" : "")
        }
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "p1", name: "Refactor Plan", kind: .skill, order: 0,
                      skillId: "skills/refactor-planner"),
            LoopStage(id: "a1", name: "Refactor Apply", kind: .skill, order: 1,
                      skillId: "skills/refactor-apply"),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 2)
        ], maxIterations: 3, consecutiveFailureStop: 3)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skillExecutor,
            approvals: makeApprovals(approve: [("t1", "swift test")]))
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 1)
        // failure, flake re-run, re-verify of the repaired stage, full confirmation
        XCTAssertEqual(verifier.calls, ["swift test", "swift test", "swift test", "swift test"])
        let applyCalls = skillExecutor.receivedMessages.filter { $0.contains("\"Refactor Apply\"") }
        let planCalls = skillExecutor.receivedMessages.filter { $0.contains("\"Refactor Plan\"") }
        XCTAssertEqual(applyCalls.count, 1, "the apply stage applies one batch per run")
        XCTAssertEqual(planCalls.count, 1, "the restart begins at the batch, after the plan stage")
        XCTAssertTrue(runner.log.contains {
            $0.text.contains("Refactor Apply already applied its batch this run; skipped")
        })
    }

    /// Stage paths are relative to the git root, so "." is the repo root —
    /// not the project root, which sits two levels up in the code/ layout.
    func testDotPathIsDescribedAsTheRepoRoot() async {
        let skillExecutor = StubSkillExecutor()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "d1", name: "Doc Index", kind: .skill, order: 0,
                      skillId: "skills/doc-structure-index", targetPath: ".",
                      outputPath: "llm-doc/docs/INDEX.md")
        ], maxIterations: 1, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skillExecutor, approvals: makeApprovals())
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        let message = skillExecutor.receivedMessages.first ?? ""
        XCTAssertTrue(message.contains("Input: \(repoRoot.path) (the repo root)."), message)
        XCTAssertFalse(message.contains("project root"), message)
    }

    /// The predicate itself: order matters, a verify stage BEFORE the apply
    /// stage does not count, and only a BLOCKING shell command verifies — the
    /// regression sweep and advisory stages do not.
    func testLacksVerifyAfterOnlyCountsAnEnabledBlockingShellStageAfterTheApply() {
        let apply = LoopStage(id: "a1", name: "Refactor Apply", kind: .skill, order: 1,
                              skillId: "skills/refactor-apply")
        let testBefore = LoopStage(id: "t0", name: "Test", kind: .shellCommand, command: "x", order: 0)
        let sweepAfter = LoopStage(id: "r2", name: "Regression", kind: .regressionSweep, order: 2)
        let advisoryAfter = LoopStage(id: "v2", name: "Lint", kind: .shellCommand, command: "x", order: 2,
                                      severity: .advisory)
        let testAfter = LoopStage(id: "t2", name: "Test", kind: .shellCommand, command: "x", order: 2)
        XCTAssertTrue(LoopStage.lacksVerifyAfter(apply, in: [testBefore, apply]))
        XCTAssertTrue(LoopStage.lacksVerifyAfter(apply, in: [testBefore, apply, sweepAfter]),
                      "the regression sweep does not verify a code edit")
        XCTAssertTrue(LoopStage.lacksVerifyAfter(apply, in: [apply, advisoryAfter]),
                      "an advisory stage never fails the run, so it does not verify")
        XCTAssertFalse(LoopStage.lacksVerifyAfter(apply, in: [testBefore, apply, testAfter]))
        XCTAssertFalse(sweepAfter.verifies)
        XCTAssertFalse(advisoryAfter.verifies)
        XCTAssertTrue(testAfter.verifies)
        let other = LoopStage(id: "s1", name: "Docs", kind: .skill, order: 0, skillId: "skills/doc-writer")
        XCTAssertFalse(LoopStage.lacksVerifyAfter(other, in: [other]), "only code-applying skills are gated")
    }

    func testDisabledSkillStageWithoutSkillDoesNotFailPreflight() async {
        // Disabling is the sanctioned way to park a half-configured stage;
        // preflight must not reject the run for a stage it will never execute.
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Generate", kind: .skill, command: nil, order: 0, enabled: false),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
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

    // MARK: - Fix 1: process-wide concurrency guard (FIFO queue)

    func testConcurrentRunsOnSameGitRootAreQueued() async {
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
        await repairer.started.wait()

        let task2 = Task { await runner2.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(runner2.waitingInQueue)
        XCTAssertTrue(LoopRunQueue.isActive(rootKey: repoRoot.path))

        await repairer.release.fire()
        _ = await task1.value
        let result2 = await task2.value
        XCTAssertNotNil(result2)
        XCTAssertFalse(runner2.waitingInQueue)
    }

    func testSameRunnerCannotReenterWhileWaitingInQueue() async throws {
        let rootKey = repoRoot.resolvingSymlinksInPath().path
        try await LoopRunQueue.acquire(rootKey: rootKey)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals())
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep,
                      command: nil, order: 0)
        ])

        let first = Task {
            await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(runner.waitingInQueue)

        let second = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertNil(second)
        XCTAssertEqual(LoopRunQueue.queuedCount(rootKey: rootKey), 1)

        LoopRunQueue.release(rootKey: rootKey)
        let firstResult = await first.value
        XCTAssertNotNil(firstResult)
    }

    /// `handleAppTerminating` is the synchronous path `willTerminate` calls —
    /// it must never be reachable through `run`'s own cooperative-cancellation
    /// exit, since the whole point is to cover the case where the process is
    /// killed out from under the awaiting `Task` and `finish()` is never
    /// reached at all. Simulated here by calling it directly mid-repair,
    /// exactly like the OS would if it fired while a stage was in flight.
    func testHandleAppTerminatingJournalsAnInterruptedRunMidRepair() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let repairer = BlockingRepairer()
        let journal = InMemoryJournal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal
        )
        let task = Task { await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot, projectId: "proj-1") }
        await repairer.started.wait()

        XCTAssertTrue(runner.running)
        XCTAssertTrue(journal.written.isEmpty, "must not journal until termination actually happens")
        runner.handleAppTerminating()

        XCTAssertEqual(journal.written.count, 1)
        let record = journal.written[0]
        XCTAssertEqual(record.statusCode, LoopEngineStatus.aborted.code)
        XCTAssertEqual(record.projectId, "proj-1")
        XCTAssertEqual(record.gitRoot, repoRoot.path)
        XCTAssertEqual(record.iterations.count, 1, "the in-progress iteration's record must be included as-is")

        // The run itself is still suspended in the repairer — release it so
        // the test doesn't leak a task, but its own eventual `finish()` (a
        // SECOND journal write) is not what this test is about.
        await repairer.release.fire()
        _ = await task.value
    }

    func testHandleAppTerminatingIsANoOpWhenNoRunIsInFlight() async {
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(),
            journal: journal
        )
        runner.handleAppTerminating()
        XCTAssertTrue(journal.written.isEmpty)
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

    /// Stop mid-repair cancels the repair's HTTP request, which surfaces as
    /// `APIError.network(URLError(.cancelled))`, not `CancellationError` —
    /// it used to end the run as a repair ERROR instead of `.aborted`.
    func testRepairURLCancellationMapsToAborted() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let repairer = ThrowingRepairer(error: APIError.network(URLError(.cancelled)))
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
    }

    func testIsCancellationRecognisesEveryStopShape() {
        XCTAssertTrue(LoopEngineRunner.isCancellation(CancellationError()))
        XCTAssertTrue(LoopEngineRunner.isCancellation(URLError(.cancelled)))
        XCTAssertTrue(LoopEngineRunner.isCancellation(APIError.network(URLError(.cancelled))))
        XCTAssertFalse(LoopEngineRunner.isCancellation(APIError.network(URLError(.timedOut))))
        XCTAssertFalse(LoopEngineRunner.isCancellation(URLError(.notConnectedToInternet)))
    }

    // MARK: - Fix 5: hash normalization ignores elapsed-time noise

    func testConsecutiveFailureDetectionIgnoresElapsedTimeNoise() async {
        let outputs = ["FAILED in 0.5s", "FAILED in 0.6s", "FAILED in 1.2s"]
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
        XCTAssertEqual(runner.iteration, 3)
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
            VerifyOutcome(exitCode: 1, output: "3 failures"),     // the flake gate's re-run
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
                // Calls 0-1: the failure and the flake gate's re-run.
                return aCallCount < 2
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
        // Iteration 1: A fails, repaired. Iteration 2: A re-verified alone
        // (passes), then the full pipeline: B fails (1st on its own), repaired.
        // Iteration 3: B fails (streak 2: the informed repair). Iteration 4: B
        // fails (streak 3) → gives up. If A's history leaked into B, B's first
        // failure would already have had a streak above 1.
        XCTAssertEqual(runner.iteration, 4)
        XCTAssertEqual(repairer.repairCount, 3)
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

    /// A skill that throws must NOT abort the run on the spot — it's logged and
    /// the verify stages still run — but a passing verify stage does not
    /// launder it: the stage never ran cleanly, so the run ends `.error`.
    func testSkillStageErrorIsNonFatalButNotLaundered() async {
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
        guard case .error(let message)? = result else { return XCTFail("got \(String(describing: result))") }
        XCTAssertTrue(message.contains("\"Fix\" errored"), message)
        XCTAssertEqual(verifier.calls, ["swift test"], "the verify stage still ran")
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
            return callIndex < 2
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
        // The stage ran twice (the failure and the flake gate's re-run): the run
        // ended before the would-be-passing verify after the repair.
        XCTAssertEqual(verifier.calls.count, 2)
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
            return callIndex < 2
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
            return callIndex < 2     // the failure and the flake gate's re-run
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

    /// An incomplete git listing is NOT "git unavailable": it fails closed and
    /// blocks exactly like a violation.
    func testUnverifiableScopeCheckBlocks() async {
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return callIndex < 2
                ? VerifyOutcome(exitCode: 1, output: "boom")
                : VerifyOutcome(exitCode: 0, output: "")
        }
        let scopeGuard = StubScopeGuard(result: .unverifiable(reason: "cut short"))
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

        guard case .blocked = result else { return XCTFail("expected blocked, got \(result)") }
        XCTAssertTrue(runner.log.contains { $0.text.contains("protected-path check incomplete") })
    }

    /// A skill stage edits the tree too, so "make the tests pass" is as available
    /// to it as it is to the repairer.
    func testSkillStageViolationAlsoBlocks() async {
        let journal = InMemoryJournal()
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
            journal: journal, scopeGuard: scopeGuard
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .blocked(reason: .repairOutOfScope(
            stageName: "Fix", paths: ["mac/Tests/A.swift"])))
        // Blocked before the Test stage ran at all.
        XCTAssertTrue(verifier.calls.isEmpty)

        // A generate step whose edits were rejected must NOT be journalled as
        // passed: the run summary renders `passed` as "pass", which would read as
        // a clean row directly above the violation that row caused.
        let attempt = journal.written[0].iterations[0].attempts[0]
        XCTAssertFalse(attempt.passed)
        XCTAssertEqual(attempt.scopeVerdict, .violatedReverted)
        XCTAssertEqual(attempt.changedPaths, ["mac/Tests/A.swift"])
    }

    // MARK: - Code-apply stages see `.warn` under a `.revert`/`.stop` loop

    private func refactorWithTest() -> [LoopStage] {
        [LoopStage(id: "a1", name: "Refactor Apply", kind: .skill, order: 0, skillId: "skills/refactor-apply"),
         LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)]
    }

    /// A move rewrites a test's import: under the loop's `.revert` (and
    /// `.stop`) the code-apply stage's edit is KEPT, journalled, and the run
    /// continues so Test verifies it; the row reads passed with the paths.
    func testCodeApplyStageProtectedEditIsKeptUnderARevertLoop() async {
        for policy in [ProtectedPathPolicy.revert, .stop] {
            let journal = InMemoryJournal()
            let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
            let scopeGuard = StubScopeGuard(result: .violated(
                paths: ["mac/Tests/A.swift"], allChangedPaths: ["mac/Tests/A.swift", "Sources/B.swift"]))
            let config = LoopEngineConfig(stages: refactorWithTest(), maxIterations: 3,
                                          consecutiveFailureStop: 2, protectedPathPolicy: policy)
            let runner = makeRunner(
                verifier: verifier, stageRepairer: StubRepairer(),
                regressionSweep: StubRegressionSweep(alwaysPasses: true),
                skillExecutor: StubSkillExecutor(),
                approvals: makeApprovals(approve: [("t1", "swift test")]),
                journal: journal, scopeGuard: scopeGuard)
            let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

            XCTAssertEqual(result, .success, "\(policy)")
            XCTAssertTrue(scopeGuard.revertedPaths.isEmpty, "the apply stage's edits must stay (\(policy))")
            XCTAssertEqual(verifier.calls, ["swift test"], "Test must run and verify the edits (\(policy))")
            let attempt = journal.written[0].iterations[0].attempts[0]
            XCTAssertTrue(attempt.passed, "an allowed touch is not a failed row (\(policy))")
            XCTAssertEqual(attempt.scopeVerdict, .violated, "the touch is still journalled (\(policy))")
            XCTAssertTrue(attempt.outputTail.contains("mac/Tests/A.swift"), attempt.outputTail)
            XCTAssertEqual(runner.stageStates["a1"], .passed)
            XCTAssertTrue(runner.log.contains { $0.text.contains("kept for a code-applying stage") })
        }
    }

    /// The same loop's Test REPAIR keeps the loop's `.revert`: editing a test
    /// to make it pass is still reverted and blocks the run.
    func testRepairInARefactorLoopIsStillRevertedAndBlocked() async {
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return VerifyOutcome(exitCode: callIndex < 2 ? 1 : 0, output: callIndex < 2 ? "boom" : "")
        }
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["mac/Tests/A.swift"], allChangedPaths: ["mac/Tests/A.swift"]))
        let config = LoopEngineConfig(stages: refactorWithTest(), maxIterations: 3,
                                      consecutiveFailureStop: 3, protectedPathPolicy: .revert)
        let repairer = StubRepairer()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .blocked(reason: .repairOutOfScope(
            stageName: "Test", paths: ["mac/Tests/A.swift"])))
        XCTAssertEqual(repairer.repairCount, 1)
        XCTAssertEqual(scopeGuard.revertedPaths, ["mac/Tests/A.swift"],
                       "only the repair's edit is reverted, once")
        XCTAssertEqual(verifier.calls.count, 2, "never re-verified after the reward-hacking repair (failure + flake re-run only)")
    }

    func testEffectivePolicyPromotesOnlyCodeApplyStagesFromRevertOrStop() {
        let apply = LoopStage(name: "Refactor Apply", kind: .skill, order: 0, skillId: "skills/refactor-apply")
        let other = LoopStage(name: "Docs", kind: .skill, order: 0, skillId: "skills/doc-writer")
        let test = LoopStage(name: "Test", kind: .shellCommand, command: "x", order: 1)
        let expected: [ProtectedPathPolicy: ProtectedPathPolicy] = [.revert: .warn, .stop: .warn, .warn: .warn, .off: .off]
        for (loop, promoted) in expected {
            let config = LoopEngineConfig(stages: [], protectedPathPolicy: loop)
            XCTAssertEqual(LoopEngineRunner.effectivePolicy(for: apply, config: config), promoted)
            XCTAssertEqual(LoopEngineRunner.effectivePolicy(for: other, config: config), loop)
            XCTAssertEqual(LoopEngineRunner.effectivePolicy(for: test, config: config), loop)
        }
    }

    /// The mirror case: a skill stage that edits only production code is a clean
    /// pass, so the guard cannot be accused of flagging ordinary work.
    func testCleanSkillStageIsJournalledAsPassed() async {
        let journal = InMemoryJournal()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let scopeGuard = StubScopeGuard(result: .clean(changedPaths: ["Sources/Thing.swift"]))
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0, skillId: "skills/fix")
        ], maxIterations: 5, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(),
            journal: journal, scopeGuard: scopeGuard
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        let attempt = journal.written[0].iterations[0].attempts[0]
        XCTAssertTrue(attempt.passed)
        XCTAssertEqual(attempt.scopeVerdict, .clean)
        XCTAssertEqual(attempt.changedPaths, ["Sources/Thing.swift"])
    }

    /// `.off` restores exactly the pre-guard behaviour, and must not pay for the
    /// git calls either.
    func testPolicyOffSkipsTheCheckEntirely() async {
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return callIndex < 2
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

    // MARK: - Scope allowlist

    /// A changed path OUTSIDE every `scopeGlobs` entry must be blocked the
    /// same way a protected-path violation is — even though the scope guard
    /// itself reported `.clean` (no denylist hit).
    func testChangeOutsideScopeAllowlistIsBlockedEvenWhenNotProtected() async {
        let scopeGuard = StubScopeGuard(result: .clean(changedPaths: ["src/other/File.swift"]))
        let repairer = StubRepairer()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 5, protectedPathPolicy: .revert)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                                      scopeGlobs: ["src/auth/**"])
        guard case .blocked(let reason) = result else {
            return XCTFail("expected .blocked, got \(String(describing: result))")
        }
        guard case .repairOutOfScope(_, let paths) = reason else {
            return XCTFail("expected .repairOutOfScope, got \(reason)")
        }
        XCTAssertEqual(paths, ["src/other/File.swift"])
        XCTAssertEqual(scopeGuard.revertedPaths, ["src/other/File.swift"])
    }

    /// A changed path INSIDE the allowlist is clean, same as today.
    func testChangeInsideScopeAllowlistIsClean() async {
        let scopeGuard = StubScopeGuard(result: .clean(changedPaths: ["src/auth/Login.swift"]))
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                                      scopeGlobs: ["src/auth/**"])
        XCTAssertNotEqual(result, .blocked(reason: .repairOutOfScope(stageName: "Test", paths: [])))
        XCTAssertTrue(scopeGuard.revertedPaths.isEmpty)
    }

    /// An empty `scopeGlobs` (the default — every loop before this feature,
    /// and any loop that never sets one) must change nothing: a denylist-only
    /// `.clean` result stays clean.
    func testEmptyScopeGlobsChangesNothing() async {
        let scopeGuard = StubScopeGuard(result: .clean(changedPaths: ["src/anywhere/File.swift"]))
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertNotEqual(result, .blocked(reason: .repairOutOfScope(stageName: "Test", paths: [])))
    }

    /// A path that is BOTH out-of-scope and denylist-protected reports the
    /// union of both violation sets — no path is silently dropped.
    func testViolationsFromDenylistAndScopeAllowlistAreMerged() async {
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["mac/Tests/Some.swift"], allChangedPaths: ["mac/Tests/Some.swift", "src/other/File.swift"]))
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 5, protectedPathPolicy: .revert)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                                      scopeGlobs: ["src/auth/**"])
        guard case .blocked(let reason) = result, case .repairOutOfScope(_, let paths) = reason else {
            return XCTFail("expected .blocked/.repairOutOfScope, got \(String(describing: result))")
        }
        XCTAssertEqual(Set(paths), Set(["mac/Tests/Some.swift", "src/other/File.swift"]))
    }

    // MARK: - Scored progress

    /// The case a hash comparison cannot see: three DIFFERENT failures that never
    /// get fewer. Before scoring, each new failure text reset the streak and the
    /// loop happily burned all ten iterations.
    func testDifferentFailuresWithAnUnchangingCountGiveUpAsNoProgress() async {
        let outputs = [
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds — alpha",
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds — alpha",
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds — beta",
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds — gamma"
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
        XCTAssertEqual(runner.iteration, 3)
    }

    /// The mirror image: a shrinking count is progress, so the loop must keep
    /// going even though every failure text differs.
    func testShrinkingScoreKeepsTheLoopRunning() async {
        let outputs = [
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds",
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds",
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 2 failures (0 unexpected) in 1.0 seconds",
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 1 failure (0 unexpected) in 1.0 seconds"
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

    /// A count that disappears (a compile error) always earns one more repair,
    /// even at `consecutiveFailureStop == 2`, and that repair is told its last
    /// change stopped the tests from running. If the build stays broken the run
    /// gives up with its own reason.
    func testCountDisappearingGetsOneInformedRepairThenItsOwnGiveUp() async {
        let outputs = [
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds",
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds",
            "Foo.swift:3:5: error: cannot find 'bar' in scope\nerror: fatalError",
            "Foo.swift:9:1: error: expected '}'"
        ]
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

        XCTAssertEqual(result, .givenUp(reason: .stoppedReporting(stageName: "Test")))
        XCTAssertEqual(repairer.repairCount, 2)
        XCTAssertEqual(repairer.evidence[1]?.stoppedRunning, true)
        XCTAssertEqual(repairer.evidence[1]?.errorExcerpt?.hasPrefix("Foo.swift:3:5: error:"), true)
        XCTAssertEqual(LoopEngineStatus.givenUp(reason: .stoppedReporting(stageName: "Test")).code,
                       "given_up.stopped_reporting")
    }

    /// Evidence is what turns a retry into an iteration: without the measured
    /// delta, the agent is handed the same failure and has no way to know its last
    /// edit did nothing.
    func testRepairerReceivesTheMeasuredDeltaAsEvidence() async {
        let outputs = [
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds",
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 3 failures (0 unexpected) in 1.0 seconds",
            "Test Suite 'All tests' failed.\nExecuted 10 tests, with 2 failures (0 unexpected) in 1.0 seconds"
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
        // `@unchecked` for the same reason the other stubs in this file are: a
        // mutable recording property on a Sendable-conforming class is an error in
        // the Swift 6 language mode, and these are only ever touched from the test's
        // own actor.
        final class TimeoutRecordingVerifier: FaultVerifier, @unchecked Sendable {
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
            return callIndex < 2
                ? VerifyOutcome(exitCode: 1, output: "Test Suite 'All tests' failed.\nExecuted 10 tests, with 4 failures (0 unexpected) in 1.0 seconds")
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

        let first = journal.written[0].iterations[0].attempts.first(where: { $0.repairAttempted })!
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

    /// A queued call must not fabricate a journal entry before it acquires
    /// the lock — that would make the run list count phantom runs.
    func testQueuedConcurrentRunIsNotJournalledUntilItStarts() async {
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
        let task2 = Task { await runner2.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(journal.written.isEmpty)

        await repairer.release.fire()
        _ = await task1.value
        let result2 = await task2.value
        XCTAssertNotNil(result2)
        XCTAssertEqual(journal.written.count, 1)
    }

    // MARK: - Summary note output

    func testSummaryNoteIsWrittenWhenEnabled() async {
        let summary = StubSummaryWriter()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2, writeSummaryNote: true)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            summaryWriter: summary
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(summary.written.count, 1)
        XCTAssertEqual(summary.written[0].statusCode, "success")
        XCTAssertTrue(runner.log.contains { $0.text.contains("Run summary note written") })
    }

    /// Off by default: the journal already records every run, and a note per run is
    /// only wanted when a person is the audience.
    func testNoSummaryNoteWhenDisabled() async {
        let summary = StubSummaryWriter()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        XCTAssertFalse(config.writeSummaryNote)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            summaryWriter: summary
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertTrue(summary.written.isEmpty)
    }

    /// Same fail-open contract as the journal: writing a note observes the work and
    /// must never change its verdict.
    func testSummaryNoteFailureIsLoggedButDoesNotChangeTheVerdict() async {
        let summary = StubSummaryWriter()
        summary.result = .failed(reason: "note index locked")
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2, writeSummaryNote: true)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            summaryWriter: summary
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertTrue(runner.log.contains { $0.text.contains("Run summary note not written: note index locked") })
    }

    /// A queued call must not produce a note before it acquires the lock.
    func testQueuedRunWritesNoSummaryNoteUntilItStarts() async {
        let summary = StubSummaryWriter()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") }
        let repairer = BlockingRepairer()
        let approvals = makeApprovals(approve: [("t1", "swift test")])
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5, writeSummaryNote: true)

        let runner1 = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(), approvals: approvals)
        let runner2 = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(), approvals: approvals, summaryWriter: summary)

        let task1 = Task { await runner1.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot) }
        await repairer.started.wait()
        let task2 = Task { await runner2.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(summary.written.isEmpty)

        await repairer.release.fire()
        _ = await task1.value
        _ = await task2.value
        XCTAssertEqual(summary.written.count, 1)
    }

    // MARK: - Loop identity (multi-loop)

    func testRunRecordsTheLoopIdAndNamePassedIn() async {
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             loopId: "loop-42", loopName: "Fix flaky tests")
        XCTAssertEqual(journal.written.last?.loopId, "loop-42")
        XCTAssertEqual(journal.written.last?.loopName, "Fix flaky tests")
    }

    /// Existing call sites that don't pass a loop identity (every test above
    /// this one) must keep working — the defaults exist precisely so this
    /// file didn't need touching for Task 4.
    func testRunWithNoLoopIdentityPassedStillJournalsSomeDefault() async {
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertFalse(journal.written.last?.loopId?.isEmpty ?? true)
    }

    func testIsLoopActiveReflectsWhichLoopOwnsAnInFlightRun() async {
        let repairer = BlockingRepairer()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5)

        XCTAssertFalse(LoopEngineRunner.isLoopActive(loopId: "loop-active", gitRoot: repoRoot))
        let task = Task {
            await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             loopId: "loop-active", loopName: "Active")
        }
        await repairer.started.wait()
        XCTAssertTrue(LoopEngineRunner.isLoopActive(loopId: "loop-active", gitRoot: repoRoot))

        await repairer.release.fire()
        _ = await task.value
        XCTAssertFalse(LoopEngineRunner.isLoopActive(loopId: "loop-active", gitRoot: repoRoot),
                       "must clear once the run finishes")
    }

    // MARK: - Goal/acceptance context

    /// The repair agent must see the loop's goal/acceptance, not just the
    /// bare failure output — that's the whole point of the fields.
    func testRepairFailureOutputIncludesGoalAndAcceptanceCriteriaWhenSet() async {
        let repairer = StubRepairer()
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        // maxIterations: 2, not 1 — the runner deliberately refuses to repair
        // when no iteration is left to verify the repair in (the
        // `iteration >= maxIterations` gate runs BEFORE the repair), so a
        // 1-iteration run can never reach the repairer this test asserts on.
        // Two iterations produce exactly one repair attempt.
        ], maxIterations: 2, consecutiveFailureStop: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             goal: "Stabilize auth", acceptanceCriteria: "swift test passes")
        XCTAssertEqual(repairer.receivedFailureOutputs.count, 1)
        let seen = repairer.receivedFailureOutputs[0]
        XCTAssertTrue(seen.contains("Stabilize auth"))
        XCTAssertTrue(seen.contains("swift test passes"))
        XCTAssertTrue(seen.contains("boom"), "the real failure output must still be present")
        // The journal must keep recording the RAW command output — the
        // goal-prefixed text is a repair-prompt-only concern, and letting
        // it leak into the journal would misrepresent what the stage
        // actually printed.
        XCTAssertEqual(journal.written.last?.iterations.last?.attempts.last?.outputTail, "boom")
    }

    /// Regression guard for the truncation-order bug: without reserving room
    /// for the header BEFORE AgentLoopStageRepairer's own tail-truncation,
    /// a large failure output pushes the goal/acceptance text entirely out
    /// of the kept window.
    func testRepairFailureOutputKeepsGoalContextEvenWhenOutputIsVeryLong() async {
        let repairer = StubRepairer()
        let longOutput = String(repeating: "x", count: 10_000)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: longOutput) },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        // maxIterations: 2, not 1 — the runner deliberately refuses to repair
        // when no iteration is left to verify the repair in (the
        // `iteration >= maxIterations` gate runs BEFORE the repair), so a
        // 1-iteration run can never reach the repairer this test asserts on.
        // Two iterations produce exactly one repair attempt.
        ], maxIterations: 2, consecutiveFailureStop: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             goal: "Stabilize auth", acceptanceCriteria: "swift test passes")
        // Simulate AgentLoopStageRepairer.buildPrompt's own downstream
        // truncation on what the repairer actually received — this is the
        // exact operation that dropped the goal/acceptance header before the
        // fix (the header sat at the front, buildPrompt kept only the tail).
        // Asserting on the untruncated string (as an earlier draft of this
        // test did) would pass even with the fix reverted, since the header
        // is always at the front regardless of trimming.
        let asBuildPromptWouldSeeIt = String(
            repairer.receivedFailureOutputs[0].suffix(AgentLoopStageRepairer.maxFailureOutputChars))
        XCTAssertTrue(asBuildPromptWouldSeeIt.contains("Stabilize auth"))
        XCTAssertTrue(asBuildPromptWouldSeeIt.contains("swift test passes"))
    }

    /// No goal/acceptance set (every loop before this feature, and every
    /// existing test above) must produce BYTE-IDENTICAL failure output to
    /// what the repairer received before this feature existed.
    func testRepairFailureOutputIsUnchangedWhenGoalAndAcceptanceAreNotSet() async {
        let repairer = StubRepairer()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        // See the sibling above: a repair needs a second iteration to exist.
        ], maxIterations: 2, consecutiveFailureStop: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(repairer.receivedFailureOutputs, ["boom"])
    }

    func testSkillMessageIncludesGoalAndAcceptanceCriteriaWhenSet() async {
        let skill = StubSkillExecutor()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill,
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0,
                      skillId: "skills/fix", targetPath: nil, prompt: nil),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             goal: "Ship the refactor", acceptanceCriteria: "no behavior change")
        XCTAssertEqual(skill.receivedMessages.count, 1)
        XCTAssertTrue(skill.receivedMessages[0].contains("Ship the refactor"))
        XCTAssertTrue(skill.receivedMessages[0].contains("no behavior change"))
    }

    // MARK: - Confined agent runs carry the run's git root

    /// A config whose skill stage and failing-once test stage together make
    /// the runner call BOTH production agent adapters.
    private func agentRootConfig(worktrees: Bool = false) -> LoopEngineConfig {
        var config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Generate", kind: .skill, order: 0,
                      skillId: "superpowers/brainstorming"),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 3, consecutiveFailureStop: 3)
        config.useWorktreesForConcurrentRuns = worktrees
        return config
    }

    private func failOnceVerifier() -> StubVerifier {
        var calls = 0
        return StubVerifier { _ in
            calls += 1
            return calls <= 2 ? VerifyOutcome(exitCode: 1, output: "1 failure")
                              : VerifyOutcome(exitCode: 0, output: "")
        }
    }

    func testEveryLoopAgentCallCarriesTheRunsGitRoot() async {
        let agent = RecordingLoopAgent()
        let runner = makeRunner(
            verifier: failOnceVerifier(),
            stageRepairer: AgentLoopStageRepairer(agent: agent),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: AgentLoopSkillExecutor(agent: agent),
            approvals: makeApprovals(approve: [("t1", "swift test")]))

        let result = await runner.run(config: agentRootConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertTrue(agent.calls.contains { $0.skills == ["superpowers/brainstorming"] }, "skill stage ran")
        XCTAssertTrue(agent.calls.contains { $0.skills.isEmpty }, "repair ran")
        XCTAssertFalse(agent.calls.isEmpty)
        for call in agent.calls {
            XCTAssertEqual(call.repoRoot, repoRoot)
        }
        XCTAssertEqual(runner.lastSkillResults["s1"]?.reply, "done", "the skill reply is kept")
        XCTAssertEqual(runner.lastRepairResults["t1"]?.reply, "done", "the repair reply is kept")
    }

    func testWorktreeRunConfinesEveryAgentCallToTheWorktree() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-agent-root-\(UUID().uuidString)", isDirectory: true)
        let mainRepo = base.appendingPathComponent("repo", isDirectory: true)
        let project = base.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: mainRepo, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        for args in [["init", "-q"], ["config", "user.email", "t@example.com"],
                     ["config", "user.name", "T"], ["commit", "--allow-empty", "-qm", "init"]] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.currentDirectoryURL = mainRepo
            p.arguments = args
            try p.run()
            p.waitUntilExit()
            XCTAssertEqual(p.terminationStatus, 0, "git \(args.joined(separator: " "))")
        }

        // Another run holds the main checkout, so this one is redirected into
        // a worktree instead of queueing.
        let mainKey = mainRepo.resolvingSymlinksInPath().path
        try await LoopRunQueue.acquire(rootKey: mainKey)
        defer { LoopRunQueue.release(rootKey: mainKey) }

        let suite = UserDefaults(suiteName: "loop-agent-root-\(UUID().uuidString)")!
        let approvals = VerifyApprovalStore(defaults: suite)
        approvals.approveStage(repo: mainRepo, stageId: "t1", command: "swift test")

        let agent = RecordingLoopAgent()
        let runner = makeRunner(
            verifier: failOnceVerifier(),
            stageRepairer: AgentLoopStageRepairer(agent: agent),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: AgentLoopSkillExecutor(agent: agent),
            approvals: approvals)

        let result = await runner.run(config: agentRootConfig(worktrees: true),
                                      faultsRoot: project, gitRoot: mainRepo)

        XCTAssertEqual(result, .success)
        XCTAssertTrue(agent.calls.contains { !$0.skills.isEmpty }, "skill stage ran")
        XCTAssertTrue(agent.calls.contains { $0.skills.isEmpty }, "repair ran")
        let worktreeParent = project.appendingPathComponent("system/loop-worktrees").path
        for call in agent.calls {
            XCTAssertNotEqual(call.repoRoot.resolvingSymlinksInPath().path, mainKey,
                              "a worktree run must never target the main checkout")
            XCTAssertTrue(call.repoRoot.path.hasPrefix(worktreeParent + "/"),
                          "\(call.repoRoot.path) is not the run's worktree")
        }
        XCTAssertEqual(Set(agent.calls.map(\.repoRoot)).count, 1, "one worktree for the whole run")
    }

    func testSkillStageWithUnresolvedSkillFailsTheStage() async {
        let agent = RecordingLoopAgent()
        agent.result = { skills in
            LoopAgentResult(unresolvedSkills: skills, ran: false, resultSubtype: nil)
        }
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier,
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: AgentLoopSkillExecutor(agent: agent),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal)

        let result = await runner.run(config: agentRootConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        let message = "skill superpowers/brainstorming is not installed"
        XCTAssertEqual(LoopEngineRunner.skillNotInstalledMessage(["superpowers/brainstorming"]), message)
        XCTAssertEqual(result, .error(message))
        XCTAssertEqual(runner.stageStates["s1"], .failed)
        XCTAssertTrue(verifier.calls.isEmpty, "the run ends at the failed skill stage")
        XCTAssertEqual(agent.calls.count, 1)
        let stageRecord = journal.written.last?.iterations.first?.attempts.first
        XCTAssertEqual(stageRecord?.passed, false)
        XCTAssertEqual(stageRecord?.outputTail, message)
    }

    /// An OPTIONAL skill stage (`LoopStage.skillIsOptional`, today only
    /// Refactor Conform) whose skill is not installed SKIPS instead of
    /// failing the run: the batch Apply already applied still finishes, and
    /// the Test stage after it still runs and passes.
    func testOptionalSkillStageWithUnresolvedSkillSkipsAndProceeds() async {
        let agent = RecordingLoopAgent()
        agent.result = { skills in
            LoopAgentResult(unresolvedSkills: skills, ran: false, resultSubtype: nil)
        }
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let journal = InMemoryJournal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Refactor Conform", kind: .skill, order: 0,
                      skillId: "skills/refactor-conform"),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1),
        ], maxIterations: 3, consecutiveFailureStop: 3)
        let runner = makeRunner(
            verifier: verifier,
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: AgentLoopSkillExecutor(agent: agent),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal)

        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        let message = LoopEngineRunner.optionalSkillSkippedMessage(
            ["skills/refactor-conform"], stageName: "Refactor Conform")
        XCTAssertEqual(result, .success, "the run finishes instead of failing over the missing optional skill")
        XCTAssertEqual(runner.stageStates["s1"], .passed)
        XCTAssertFalse(verifier.calls.isEmpty, "the Test stage after it still runs")
        let stageRecord = journal.written.last?.iterations.first?.attempts.first
        XCTAssertEqual(stageRecord?.passed, true)
        XCTAssertEqual(stageRecord?.outputTail, message)
        XCTAssertTrue(message.contains("Apply Central Skills to the project to enable Refactor Conform"))
    }

    // MARK: - Honest verdicts (errored stages, transport retry)

    private func skillOnlyConfig() -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Plan", kind: .skill, command: nil, order: 0,
                      skillId: "skills/plan", targetPath: nil, prompt: nil)
        ], maxIterations: 3, consecutiveFailureStop: 2)
    }

    private func skillThenTestConfig() -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0,
                      skillId: "skills/fix", targetPath: nil, prompt: nil),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 2, consecutiveFailureStop: 5)
    }

    private static let refused = APIError.network(URLError(.cannotConnectToHost))

    /// A Plan/Docs-shaped loop (skill stages only) against a dead backend used
    /// to report `.success` having done nothing.
    func testSkillOnlyLoopWithADeadBackendEndsInError() async {
        let skill = StubSkillExecutor()
        skill.throwOnEveryCall = true
        skill.everyCallError = Self.refused
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill, approvals: makeApprovals(), journal: journal)
        let result = await runner.run(config: skillOnlyConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        guard case .error(let message) = result else { return XCTFail("got \(String(describing: result))") }
        XCTAssertTrue(message.contains("\"Plan\" errored"), message)
        XCTAssertEqual(skill.callCount, 2, "one call plus exactly one retry")
        XCTAssertEqual(runner.stageStates["s1"], .errored)
        XCTAssertEqual(journal.written.last?.iterations.first?.attempts.first?.errored, true)
        XCTAssertEqual(journal.written.last?.statusCode, "error")
    }

    func testOneTransportBlipIsRetriedAndTheStageCompletes() async {
        let skill = StubSkillExecutor()
        skill.queuedErrors = [Self.refused]
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill, approvals: makeApprovals(), journal: journal)
        let result = await runner.run(config: skillOnlyConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(skill.callCount, 2)
        XCTAssertEqual(runner.stageStates["s1"], .passed)
        XCTAssertNil(journal.written.last?.iterations.first?.attempts.first?.errored)
    }

    func testAgentRunTimeoutIsNotRetried() async {
        let skill = StubSkillExecutor()
        skill.throwOnEveryCall = true
        skill.everyCallError = APIError.http(status: 504, code: "AGENT_RUN_TIMEOUT",
                                             message: "timed out", details: nil)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill, approvals: makeApprovals())
        let result = await runner.run(config: skillOnlyConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        guard case .error = result else { return XCTFail("got \(String(describing: result))") }
        XCTAssertEqual(skill.callCount, 1)
    }

    /// An errored stage plus a verify stage that never passes: the give-up
    /// would blame the tests, but the real cause is that nothing ran.
    func testErroredStageWithAFailingVerifyEndsInErrorNotGiveUp() async {
        let skill = StubSkillExecutor()
        skill.throwOnEveryCall = true
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill, approvals: makeApprovals(approve: [("t1", "swift test")]))
        let result = await runner.run(config: skillThenTestConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        guard case .error(let message) = result else { return XCTFail("got \(String(describing: result))") }
        XCTAssertTrue(message.contains("given up (max iterations)"), message)
    }

    /// A 502 may come from mid-run — the agent may already have edited — so
    /// it is not retried; the repair error ends the run.
    /// A skill that errors only in iteration 1 does not taint a run whose
    /// final iteration's verify passes.
    func testSkillErrorInAnEarlierIterationDoesNotFailAVerifiedRun() async {
        let skill = StubSkillExecutor()
        skill.queuedErrors = [SkillError()]
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return callIndex < 2 ? VerifyOutcome(exitCode: 1, output: "boom") : VerifyOutcome(exitCode: 0, output: "")
        }
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill, approvals: makeApprovals(approve: [("t1", "swift test")]))
        let result = await runner.run(config: skillThenTestConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(skill.callCount, 2)
    }

    /// An apply stage that ERRORED applied nothing, so the retry iteration
    /// must run it again rather than skip it as "already applied".
    func testErroredCodeApplyIsRetriedNextIteration() async {
        let skill = StubSkillExecutor()
        skill.queuedErrors = [SkillError()]
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return callIndex < 2 ? VerifyOutcome(exitCode: 1, output: "boom") : VerifyOutcome(exitCode: 0, output: "")
        }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "a1", name: "Refactor Apply", kind: .skill, order: 0,
                      skillId: "skills/refactor-apply"),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 3, consecutiveFailureStop: 3)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill, approvals: makeApprovals(approve: [("t1", "swift test")]))
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(skill.callCount, 2, "the errored apply ran again in iteration 2")
        XCTAssertFalse(runner.log.contains { $0.text.contains("already applied") })
    }

    func testRepair5xxIsNotRetried() async {
        final class FlakyRepairer: LoopStageRepairer {
            var calls = 0
            func repair(stageName: String, command: String?, failureOutput: String,
                        evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
                calls += 1
                throw APIError.http(status: 502, code: "INTERNAL_ERROR", message: "x", details: nil)
            }
        }
        let repairer = FlakyRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(), approvals: makeApprovals(approve: [("t1", "swift test")]))
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        guard case .error = result else { return XCTFail("got \(String(describing: result))") }
        XCTAssertEqual(repairer.calls, 1)
    }

    func testRepairThatCouldNotConnectIsRetriedOnce() async {
        final class FlakyRepairer: LoopStageRepairer {
            var calls = 0
            func repair(stageName: String, command: String?, failureOutput: String,
                        evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
                calls += 1
                if calls == 1 { throw APIError.network(NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNREFUSED))) }
                return LoopAgentResult()
            }
        }
        var callIndex = 0
        let verifier = StubVerifier { _ in
            defer { callIndex += 1 }
            return callIndex < 2 ? VerifyOutcome(exitCode: 1, output: "boom") : VerifyOutcome(exitCode: 0, output: "")
        }
        let repairer = FlakyRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 5)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(), approvals: makeApprovals(approve: [("t1", "swift test")]))
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(repairer.calls, 2)
    }

    /// Retry only what provably never reached a running agent.
    func testIsRetryableTransportClassifiesErrors() {
        typealias R = LoopEngineRunner
        func posix(_ code: Int32) -> Error { APIError.network(NSError(domain: NSPOSIXErrorDomain, code: Int(code))) }
        func http(_ status: Int, _ code: String) -> Error {
            APIError.http(status: status, code: code, message: "", details: nil)
        }
        // Never connected — retried.
        XCTAssertTrue(R.isRetryableTransport(APIError.network(URLError(.cannotConnectToHost))))
        XCTAssertTrue(R.isRetryableTransport(posix(ECONNREFUSED)))
        // Timeouts — the agent may be running.
        XCTAssertFalse(R.isRetryableTransport(APIError.network(URLError(.timedOut))))
        XCTAssertFalse(R.isRetryableTransport(posix(ETIMEDOUT)))
        // A dropped connection on a single non-streaming POST — may be mid-run.
        XCTAssertFalse(R.isRetryableTransport(APIError.network(URLError(.networkConnectionLost))))
        XCTAssertFalse(R.isRetryableTransport(posix(ECONNRESET)))
        // Every 5xx.
        XCTAssertFalse(R.isRetryableTransport(http(500, "X")))
        XCTAssertFalse(R.isRetryableTransport(http(502, "INTERNAL_ERROR")))
        XCTAssertFalse(R.isRetryableTransport(http(503, "NO_KEY")))
        XCTAssertFalse(R.isRetryableTransport(http(504, "AGENT_RUN_TIMEOUT")))
        // Other shapes.
        XCTAssertFalse(R.isRetryableTransport(http(400, "BAD")))
        XCTAssertFalse(R.isRetryableTransport(APIError.network(URLError(.cancelled))))
        XCTAssertFalse(R.isRetryableTransport(APIError.agent(message: "nope")))
        XCTAssertFalse(R.isRetryableTransport(SkillError()))
    }

    // MARK: - Guard on the throw path

    private func violatingGuard(_ path: String) -> StubScopeGuard {
        StubScopeGuard(result: .violated(paths: [path], allChangedPaths: [path]))
    }

    /// A repair that edits a test and THEN fails must not slip past the guard
    /// as a mere "repair error".
    func testThrowingRepairThatEditedAProtectedPathIsStillBlocked() async {
        let scopeGuard = violatingGuard("mac/Tests/FooTests.swift")
        let journal = InMemoryJournal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 5, protectedPathPolicy: .revert)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: ThrowingRepairer(error: SkillError()),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal, scopeGuard: scopeGuard)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .blocked(reason: .repairOutOfScope(
            stageName: "Test", paths: ["mac/Tests/FooTests.swift"])))
        XCTAssertEqual(scopeGuard.revertedPaths, ["mac/Tests/FooTests.swift"])
        let attempt = journal.written.last?.iterations.first?.attempts.first(where: { $0.repairAttempted })
        XCTAssertEqual(attempt?.changedPaths, ["mac/Tests/FooTests.swift"])
        XCTAssertEqual(attempt?.scopeVerdict, .violatedReverted)
    }

    func testThrowingSkillThatEditedAProtectedPathIsBlocked() async {
        let skill = StubSkillExecutor()
        skill.throwOnEveryCall = true
        let scopeGuard = violatingGuard("Makefile")
        var config = skillOnlyConfig()
        config.protectedPathPolicy = .stop
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill, approvals: makeApprovals(), scopeGuard: scopeGuard)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .blocked(reason: .repairOutOfScope(stageName: "Plan", paths: ["Makefile"])))
        XCTAssertEqual(scopeGuard.checkCount, 2, "checked, then re-checked after the throw")
        XCTAssertTrue(scopeGuard.revertedPaths.isEmpty)
    }

    /// Reverting an already-dirty file would restore HEAD and discard the
    /// uncommitted edits that were there first — so it is left, and still blocks.
    func testRevertSkipsPathsThatWereAlreadyDirty() async {
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["Makefile", "mac/Tests/FooTests.swift"],
            allChangedPaths: ["Makefile", "mac/Tests/FooTests.swift"]))
        scopeGuard.dirtyBefore = ["mac/Tests/FooTests.swift"]
        let journal = InMemoryJournal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 5, protectedPathPolicy: .revert)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal, scopeGuard: scopeGuard)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        guard case .blocked = result else { return XCTFail("got \(String(describing: result))") }
        XCTAssertEqual(scopeGuard.revertedPaths, ["Makefile"])
        XCTAssertEqual(journal.written.last?.iterations.first?.attempts.first(where: { $0.repairAttempted })?.scopeVerdict, .violated)
    }

    // MARK: - Regression stage: score, guarded sweep repairs, needs approval

    /// Returns a fixed outcome; when `repairWith` is set, first runs one
    /// repair through the guard the runner passed (as the real sweep does for
    /// a failing fault) and records whether the guard kept it.
    private final class ScriptedRegressionSweep: RegressionSweepRunning {
        let outcome: SweepOutcome
        var repairWith: ((TimeInterval?) async throws -> LoopAgentResult)?
        private(set) var guardVerdicts: [Bool] = []
        private(set) var receivedGuard = false
        init(_ outcome: SweepOutcome) { self.outcome = outcome }
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
                   repairGuard: FaultRepairGuard?) async -> SweepOutcome {
            receivedGuard = repairGuard != nil
            if let repairWith, let repairGuard, let root = gitRoot {
                if let kept = try? await repairGuard(root, repairWith) { guardVerdicts.append(kept) }
            }
            return outcome
        }
    }

    private func outcome(total: Int, regressed: Int = 0, unchanged: Int = 0, repaired: Int = 0,
                         repairFailed: Int = 0, needsApproval: Int = 0) -> SweepOutcome {
        let passed = regressed + repairFailed + needsApproval == 0 && unchanged + repaired == total
        return SweepOutcome(passed: passed, total: total, regressed: regressed, unchanged: unchanged,
                            repaired: repaired, repairFailed: repairFailed,
                            needsApproval: needsApproval, failed: 0, pending: 0)
    }

    private func regressionOnlyConfig(policy: ProtectedPathPolicy = .revert) -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 2, consecutiveFailureStop: 5, protectedPathPolicy: policy)
    }

    /// With repair on, a failing fault is `.repairFailed`, never `.regressed`,
    /// so the old `regressed` score was always 0. The score is the failing count.
    func testRegressionScoreIsTheFailingFaultCount() async {
        let sweep = ScriptedRegressionSweep(outcome(total: 3, unchanged: 1, repairFailed: 2))
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: sweep,
            skillExecutor: StubSkillExecutor(), approvals: makeApprovals(), journal: journal)
        _ = await runner.run(config: regressionOnlyConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        let attempt = journal.written.last?.iterations.first?.attempts.first
        XCTAssertEqual(attempt?.score, 2)
        XCTAssertTrue(attempt?.outputTail.contains("2 failing") ?? false, attempt?.outputTail ?? "")
        XCTAssertTrue(sweep.receivedGuard, "the sweep's repairs must run through the guard")
    }

    func testRegressionFaultNeedingApprovalStopsAsNeedsApproval() async {
        let sweep = ScriptedRegressionSweep(outcome(total: 2, unchanged: 1, needsApproval: 1))
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: sweep,
            skillExecutor: StubSkillExecutor(), approvals: makeApprovals())
        let result = await runner.run(config: regressionOnlyConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .needsApproval(stageName: "Regression"))
        XCTAssertEqual(runner.iteration, 1, "no retry can approve a command")
    }

    /// A sweep repair that edits a fault's test is rejected by the guard (so
    /// the sweep does not re-verify it) and the run is blocked — even though
    /// the sweep itself reported a pass.
    func testSweepRepairThatTouchesAProtectedPathIsRejectedAndBlocks() async {
        let sweep = ScriptedRegressionSweep(outcome(total: 1, repaired: 1))
        sweep.repairWith = { _ in LoopAgentResult() }
        let scopeGuard = violatingGuard("tests/test_fault.py")
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: sweep,
            skillExecutor: StubSkillExecutor(), approvals: makeApprovals(), scopeGuard: scopeGuard)
        let result = await runner.run(config: regressionOnlyConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(sweep.guardVerdicts, [false])
        XCTAssertEqual(scopeGuard.revertedPaths, ["tests/test_fault.py"])
        XCTAssertEqual(result, .blocked(reason: .repairOutOfScope(
            stageName: "Regression", paths: ["tests/test_fault.py"])))
    }

    func testSweepRepairUnderWarnPolicyIsKept() async {
        let sweep = ScriptedRegressionSweep(outcome(total: 1, repaired: 1))
        sweep.repairWith = { _ in LoopAgentResult() }
        let scopeGuard = violatingGuard("tests/test_fault.py")
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: sweep,
            skillExecutor: StubSkillExecutor(), approvals: makeApprovals(), scopeGuard: scopeGuard)
        let result = await runner.run(config: regressionOnlyConfig(policy: .warn),
                                      faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(sweep.guardVerdicts, [true])
        XCTAssertTrue(scopeGuard.revertedPaths.isEmpty)
        XCTAssertEqual(result, .success)
    }

    // MARK: - Default timeouts, budget watchdog, event log

    private final class TimeoutCapturingVerifier: FaultVerifier {
        private(set) var timeouts: [TimeInterval] = []
        let outcome: () throws -> VerifyOutcome
        init(_ outcome: @escaping () throws -> VerifyOutcome) { self.outcome = outcome }
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            timeouts.append(timeout)
            return try outcome()
        }
    }

    private final class EventJournal: LoopRunJournaling {
        private(set) var written: [LoopRunRecord] = []
        private(set) var events: [LoopRunEvent] = []
        private(set) var eventRunIds: Set<String> = []
        func write(_ record: LoopRunRecord, root: URL) -> String? { written.append(record); return nil }
        func recentRuns(root: URL, limit: Int) -> [LoopRunIndexEntry] { [] }
        func appendEvent(_ event: LoopRunEvent, runId: String, root: URL) {
            events.append(event); eventRunIds.insert(runId)
        }
    }

    private func timeoutRunner(_ verifier: FaultVerifier, shell: TimeInterval, agent: TimeInterval,
                               journal: LoopRunJournaling? = nil) -> LoopEngineRunner {
        LoopEngineRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true), skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]), stageTimeout: 0,
            journal: journal ?? InMemoryJournal(), summaryWriter: StubSummaryWriter(),
            scopeGuard: StubScopeGuard(), transportRetryDelay: 0,
            defaultShellTimeout: shell, defaultAgentTimeout: agent)
    }

    func testStageWithoutATimeoutInheritsTheAppDefaults() async {
        let verifier = TimeoutCapturingVerifier { VerifyOutcome(exitCode: 0, output: "") }
        let runner = timeoutRunner(verifier, shell: 1800, agent: 1200)
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 2)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(verifier.timeouts, [1800])
        XCTAssertEqual(runner.agentTimeout(for: config.stages[0]), 1200)
        var own = config.stages[0]; own.timeoutSeconds = 60
        XCTAssertEqual(runner.shellTimeout(for: own), 60, "a stage's own timeout wins")
    }

    func testShellStageIsClampedToTheRemainingBudgetAndEndsTheRunWhenItTimesOut() async {
        let verifier = TimeoutCapturingVerifier { throw VerifyError.timedOut(1) }
        let runner = timeoutRunner(verifier, shell: 1800, agent: 1200)
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5, wallClockBudgetSeconds: 0)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(verifier.timeouts, [1], "clamped to the (exhausted) budget, never above it")
        XCTAssertEqual(result, .givenUp(reason: .wallClockExceeded))
        XCTAssertEqual(runner.iteration, 1)
    }

    func testRunAppendsEventsInOrderUnderOneRunIdAndFinalRecordSharesIt() async {
        let journal = EventJournal()
        let verifier = TimeoutCapturingVerifier { VerifyOutcome(exitCode: 0, output: "") }
        let runner = timeoutRunner(verifier, shell: 0, agent: 0, journal: journal)
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 2)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(journal.events.map(\.kind), [
            LoopRunEvent.Kind.started, LoopRunEvent.Kind.iterationStarted,
            LoopRunEvent.Kind.stageStarted, LoopRunEvent.Kind.stageFinished,
            LoopRunEvent.Kind.verdict])
        XCTAssertEqual(journal.eventRunIds.count, 1)
        XCTAssertEqual(journal.written.first?.id, journal.eventRunIds.first)
        XCTAssertEqual(journal.events.first?.start?.id, journal.written.first?.id)
    }

    private final class DeadlineCapturingSweep: RegressionSweepRunning {
        private(set) var deadlines: [Date?] = []
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
                   repairGuard: FaultRepairGuard?) async -> SweepOutcome {
            XCTFail("the runner must call the deadline-aware overload")
            return SweepOutcome(passed: true, total: 0, regressed: 0, unchanged: 0, repaired: 0,
                                repairFailed: 0, needsApproval: 0, failed: 0, pending: 0)
        }
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
                   repairGuard: FaultRepairGuard?, deadline: Date?) async -> SweepOutcome {
            deadlines.append(deadline)
            return SweepOutcome(passed: true, total: 0, regressed: 0, unchanged: 0, repaired: 0,
                                repairFailed: 0, needsApproval: 0, failed: 0, pending: 0)
        }
    }

    func testRegressionSweepReceivesTheRunsBudgetDeadline() async {
        for (budget, expectDeadline) in [(Double?(600), true), (nil, false)] {
            let sweep = DeadlineCapturingSweep()
            let runner = LoopEngineRunner(
                verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
                stageRepairer: StubRepairer(), regressionSweep: sweep, skillExecutor: StubSkillExecutor(),
                approvals: makeApprovals(), journal: InMemoryJournal(), summaryWriter: StubSummaryWriter(),
                scopeGuard: StubScopeGuard(), transportRetryDelay: 0)
            let config = LoopEngineConfig(stages: [
                LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
            ], maxIterations: 1, wallClockBudgetSeconds: budget)
            _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
            XCTAssertEqual(sweep.deadlines.count, 1)
            XCTAssertEqual(sweep.deadlines.first.flatMap { $0 } != nil, expectDeadline)
            if let d = sweep.deadlines.first.flatMap({ $0 }) {
                XCTAssertLessThanOrEqual(d.timeIntervalSinceNow, 600)
                XCTAssertGreaterThan(d.timeIntervalSinceNow, 500)
            }
        }
    }

    // MARK: - Artifact check stage

    private final class WritingSkillExecutor: LoopSkillExecuting {
        private(set) var messages: [String] = []
        let onCall: (Int) throws -> Void
        init(onCall: @escaping (Int) throws -> Void) { self.onCall = onCall }
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
            messages.append(message)
            try onCall(messages.count)
            return LoopAgentResult()
        }
    }

    private func makeTempRepo() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("artifact-run-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    /// The flake gate re-runs a failed Test stage; when the re-run passes, the
    /// ledger op must see the PASSING run, not the first run's failing output.
    func testLedgerOpAfterFlakyTestStageOpensNoFaults() async throws {
        let repo = try makeTempRepo()
        var call = 0
        let verifier = StubVerifier { _ in
            defer { call += 1 }
            return call == 0
                ? VerifyOutcome(exitCode: 1, output: "/p/A.swift:7: error: -[M.C testFlaky] : XCTAssertTrue failed")
                : VerifyOutcome(exitCode: 0, output: "Test Case '-[M.C testFlaky]' passed (0.001 seconds).")
        }
        let journal = InMemoryJournal()
        let approvals = makeApprovals()
        approvals.approveStage(repo: repo, stageId: "t1", command: "swift test")
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0),
            LoopStage(id: "l1", name: "Ledger", kind: .testMap, order: 1, testOp: .ledger),
        ], maxIterations: 3, consecutiveFailureStop: 3)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: approvals, journal: journal)
        let result = await runner.run(config: config, faultsRoot: repo, gitRoot: repo)
        XCTAssertEqual(result, .success)
        let ledgerAttempt = journal.written.last?.iterations.flatMap(\.attempts).last { $0.kind == .testMap }
        XCTAssertEqual(ledgerAttempt?.newFaults, [])
        let faults = (try? FileManager.default.contentsOfDirectory(atPath: repo.appendingPathComponent("system/faults").path)) ?? []
        XCTAssertTrue(faults.isEmpty)
    }

    /// A Test stage that fails and never passes must still feed the ledger: the
    /// ledger's own position (after Test) is never reached, so the runner hands
    /// it the failing output before the stage gives up.
    func testLedgerRecordsFaultsFromAFailingTestStageThatNeverPasses() async throws {
        let repo = try makeTempRepo()
        let verifier = StubVerifier { _ in
            VerifyOutcome(exitCode: 1, output: "/p/A.swift:7: error: -[M.C testBroken] : XCTAssertTrue failed\n"
                          + "Test Case '-[M.C testBroken]' failed (0.001 seconds).")
        }
        let journal = InMemoryJournal()
        let approvals = makeApprovals()
        approvals.approveStage(repo: repo, stageId: "t1", command: "swift test")
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0),
            LoopStage(id: "l1", name: "Ledger", kind: .testMap, order: 1, testOp: .ledger),
        ], maxIterations: 3, consecutiveFailureStop: 3, maxRepairsPerStage: 0)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: approvals, journal: journal)
        let result = await runner.run(config: config, faultsRoot: repo, gitRoot: repo)
        XCTAssertNotEqual(result, .success)
        let ledgerAttempts = journal.written.last?.iterations.flatMap(\.attempts).filter { $0.kind == .testMap } ?? []
        XCTAssertEqual(ledgerAttempts.count, 1)
        let ids = ledgerAttempts.first?.newFaults ?? []
        XCTAssertEqual(ids.count, 1)
        let dir = repo.appendingPathComponent("system/faults")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        XCTAssertEqual(files.count, 1)
        let text = files.first.flatMap { try? String(contentsOf: dir.appendingPathComponent($0)) } ?? ""
        XCTAssertTrue(text.contains("test:\(ids.first ?? "?")"), text)
    }

    /// The create-only guard must not revert a file that held the user's own
    /// uncommitted edits before the writer ran — but the stage still fails.
    func testWriteGuardLeavesPreDirtyFileAndFails() async throws {
        let repo = try makeTempRepo()
        func git(_ args: String) throws {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", "cd '\(repo.path)' && git \(args)"]
            p.standardOutput = Pipe(); p.standardError = Pipe()
            try p.run(); p.waitUntilExit()
        }
        try "one\n".write(to: repo.appendingPathComponent("A.swift"), atomically: true, encoding: .utf8)
        try git("init -q && git add . && git -c user.email=a@b -c user.name=t commit -qm init")
        try "user edit\n".write(to: repo.appendingPathComponent("A.swift"), atomically: true, encoding: .utf8)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true), skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(), scopeGuard: GitRepairScopeGuard())
        runner.testStructure = TestStructure(generatedAt: Date(), roots: [
            TestRoot(packageDir: "", testDir: "Tests", runner: .xctest, command: "swift test", namingRule: "", languages: ["swift"])
        ], status: "ok", notes: [])
        runner.lastGuardSnapshot = RepairScopeSnapshot(dirtyPaths: ["A.swift"], usable: true, reason: nil)
        let writer = LoopStage(name: "Test Write", kind: .skill, order: 0, skillId: "skills/test-gap-writer")
        let message = await runner.enforceTestWriteOnly(
            stage: writer, result: LoopAgentResult(changedPaths: ["A.swift"]), changed: ["A.swift"], gitRoot: repo)
        XCTAssertTrue(message?.contains("left in place: A.swift") == true, message ?? "nil")
        XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("A.swift")), "user edit\n")
    }

    private func gitRepo(files: [String: String]) throws -> URL {
        let repo = try makeTempRepo()
        for (name, text) in files {
            try text.write(to: repo.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "cd '\(repo.path)' && git init -q && git add . && git -c user.email=a@b -c user.name=t commit -qm init"]
        p.standardOutput = Pipe(); p.standardError = Pipe()
        try p.run(); p.waitUntilExit()
        return repo
    }

    private func swiftStructure() -> TestStructure {
        TestStructure(generatedAt: Date(), roots: [
            TestRoot(packageDir: "", testDir: "Tests", runner: .xctest, command: "swift test", namingRule: "", languages: ["swift"])
        ], status: "ok", notes: [])
    }

    /// Policy `.off` used to skip the snapshot, so the guard reverted the user's
    /// own uncommitted edits to HEAD. With no snapshot it must revert nothing.
    func testWriteGuardWithoutSnapshotRevertsNothingAndFails() async throws {
        let repo = try gitRepo(files: ["A.swift": "one\n"])
        try "user edit\n".write(to: repo.appendingPathComponent("A.swift"), atomically: true, encoding: .utf8)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true), skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(), scopeGuard: GitRepairScopeGuard())
        runner.testStructure = swiftStructure()
        runner.lastGuardSnapshot = nil
        let writer = LoopStage(name: "Test Write", kind: .skill, order: 0, skillId: "skills/test-gap-writer")
        let message = await runner.enforceTestWriteOnly(
            stage: writer, result: LoopAgentResult(changedPaths: ["A.swift"]), changed: ["A.swift"], gitRoot: repo)
        XCTAssertTrue(message?.contains("no snapshot") == true, message ?? "nil")
        XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("A.swift")), "user edit\n")
        let setup = LoopStage(name: "Test Setup", kind: .skill, order: 0, skillId: "skills/test-structure-setup")
        try "user edit\n".write(to: repo.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        let setupMessage = await runner.enforceTestSetupOnly(
            stage: setup, result: LoopAgentResult(changedPaths: ["A.swift"]), changed: ["A.swift"], gitRoot: repo)
        XCTAssertTrue(setupMessage?.contains("no snapshot") == true, setupMessage ?? "nil")
        XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("A.swift")), "user edit\n")
    }

    /// Under policy `.off` the writer stage still snapshots before the agent runs.
    func testTestWriterStageSnapshotsUnderProtectedPathPolicyOff() async throws {
        let repo = try makeTempRepo()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true), skillExecutor: StubSkillExecutor(),
            approvals: { let a = makeApprovals(); a.approveStage(repo: repo, stageId: "t1", command: "echo ok"); return a }())
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "w1", name: "Test Write", kind: .skill, order: 0, skillId: "skills/test-gap-writer"),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "echo ok", order: 1),
        ], maxIterations: 2, protectedPathPolicy: .off)
        _ = await runner.run(config: config, faultsRoot: repo, gitRoot: repo)
        XCTAssertNotNil(runner.lastGuardSnapshot)
    }

    /// A created path the server reports outside the repo is never deleted.
    func testWriteGuardNeverDeletesACreatedPathOutsideTheRepo() async throws {
        let parent = try makeTempRepo()
        let repo = parent.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try "keep\n".write(to: repo.appendingPathComponent("A.swift"), atomically: true, encoding: .utf8)
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "cd '\(repo.path)' && git init -q && git add . && git -c user.email=a@b -c user.name=t commit -qm init"]
        p.standardOutput = Pipe(); p.standardError = Pipe()
        try p.run(); p.waitUntilExit()
        let outside = parent.appendingPathComponent("outside.swift")
        try "precious\n".write(to: outside, atomically: true, encoding: .utf8)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true), skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(), scopeGuard: GitRepairScopeGuard())
        runner.testStructure = swiftStructure()
        runner.lastGuardSnapshot = RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        let writer = LoopStage(name: "Test Write", kind: .skill, order: 0, skillId: "skills/test-gap-writer")
        let message = await runner.enforceTestWriteOnly(
            stage: writer, result: LoopAgentResult(changedPaths: ["../outside.swift"], createdPaths: ["../outside.swift"]),
            changed: ["../outside.swift"], gitRoot: repo)
        XCTAssertTrue(message?.contains("left in place: ../outside.swift") == true, message ?? "nil")
        XCTAssertEqual(try String(contentsOf: outside), "precious\n")
    }

    private final class CreatingSkillExecutor: LoopSkillExecuting {
        let created: [String]
        init(created: [String]) { self.created = created }
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
            for path in created {
                let url = repoRoot.appendingPathComponent(path)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try "def test_x(): pass\n".write(to: url, atomically: true, encoding: .utf8)
            }
            return LoopAgentResult(createdPaths: created)
        }
    }

    /// The writer created a file under a root whose command differs from the Test
    /// stage's: the Test stage must run that command too, and fail with its exit code.
    func testTestStageAlsoRunsTheWrittenRootsCommand() async throws {
        let repo = try makeTempRepo()
        for (name, text) in ["package.json": "{\"scripts\":{\"test\":\"node --test tests/\"}}",
                             "tests/a.test.mjs": "test('x',()=>{})",
                             "sub/pytest.ini": "[pytest]\n"] {
            let url = repo.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        }
        try FileManager.default.createDirectory(at: repo.appendingPathComponent("sub/tests"), withIntermediateDirectories: true)
        let verifier = StubVerifier { command in
            command == "cd sub && pytest" ? VerifyOutcome(exitCode: 3, output: "boom") : VerifyOutcome(exitCode: 0, output: "ok")
        }
        let approvals = makeApprovals()
        approvals.approveStage(repo: repo, stageId: "t1", command: "echo ok")
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "w1", name: "Test Write", kind: .skill, order: 0, skillId: "skills/test-gap-writer"),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "echo ok", order: 1),
        ], maxIterations: 2, maxRepairsPerStage: 0)
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: CreatingSkillExecutor(created: ["sub/tests/test_x.py"]),
            approvals: approvals, journal: journal)
        let result = await runner.run(config: config, faultsRoot: repo, gitRoot: repo)
        XCTAssertNotEqual(result, .success)
        XCTAssertEqual(verifier.calls, ["echo ok", "cd sub && pytest"])
        XCTAssertTrue(runner.lastVerifyOutputs["t1"]?.contains("--- also ran: cd sub && pytest ---") == true)
        let attempt = journal.written.last?.iterations.flatMap(\.attempts).last { $0.stageId == "t1" }
        XCTAssertEqual(attempt?.exitCode, 3)
    }

    func testWrittenRootCommandsSkipUnsafePackageDirs() {
        func root(_ dir: String, _ cmd: String) -> TestRoot {
            TestRoot(packageDir: dir, testDir: dir + "/tests", runner: .pytest, command: cmd, namingRule: "", languages: ["py"])
        }
        let r = LoopEngineRunner.writtenRootCommands(
            [root("sub", "cd sub && pytest"), root("evil; curl x|sh", "cd 'evil; curl x|sh' && pytest"), root("", "npm test")],
            excluding: "npm test")
        XCTAssertEqual(r.commands, ["cd sub && pytest"])
        XCTAssertEqual(r.skipped, ["evil; curl x|sh"])
    }

    func testFailureLedgerSelectionIsScopedToTheTestStage() {
        let stages = [
            LoopStage(id: "b", name: "Build", kind: .shellCommand, command: "make", order: 0),
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "make test", order: 1),
            LoopStage(id: "l", name: "Ledger", kind: .testMap, order: 2, testOp: .ledger),
        ]
        // Test ran this iteration: a failing Build does not feed the ledger past it.
        XCTAssertNil(LoopEngineRunner.ledgerStage(after: "b", in: stages, ranIds: ["b", "t"]))
        // Test never ran (Build failed first): the ledger is still reached.
        XCTAssertEqual(LoopEngineRunner.ledgerStage(after: "b", in: stages, ranIds: ["b"])?.id, "l")
        XCTAssertEqual(LoopEngineRunner.ledgerStage(after: "t", in: stages)?.id, "l")
    }

    /// A blocking baseline that refuses repair fails the run, and its failure
    /// still reaches the ledger: the refactor test stage between them never ran,
    /// so it must not hide the baseline's failure.
    func testBaselineFailureReachesTheLedgerPastAnUnrunTestStage() async throws {
        let repo = try makeTempRepo()
        let verifier = StubVerifier { _ in
            VerifyOutcome(exitCode: 1, output: "/p/A.swift:7: error: -[M.C testBroken] : XCTAssertTrue failed\n"
                          + "Test Case '-[M.C testBroken]' failed (0.001 seconds).")
        }
        let journal = InMemoryJournal()
        let approvals = makeApprovals()
        approvals.approveStage(repo: repo, stageId: "b1", command: "swift test")
        approvals.approveStage(repo: repo, stageId: "r1", command: "swift test --filter Refactor")
        var baseline = LoopStage(id: "b1", name: "Test Baseline", kind: .shellCommand, command: "swift test", order: 0)
        baseline.allowsRepair = false
        let config = LoopEngineConfig(stages: [
            baseline,
            LoopStage(id: "r1", name: "Refactor Test", kind: .shellCommand, command: "swift test --filter Refactor", order: 1),
            LoopStage(id: "l1", name: "Ledger", kind: .testMap, order: 2, testOp: .ledger),
        ], maxIterations: 3, consecutiveFailureStop: 3)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: approvals, journal: journal)
        let result = await runner.run(config: config, faultsRoot: repo, gitRoot: repo)
        XCTAssertEqual(result, .error("stage Test Baseline failed and does not allow repair"))
        XCTAssertEqual(verifier.calls, ["swift test"], "the refactor test never ran")
        let ledgerAttempts = journal.written.last?.iterations.flatMap(\.attempts).filter { $0.kind == .testMap } ?? []
        XCTAssertEqual(ledgerAttempts.count, 1)
        XCTAssertEqual(ledgerAttempts.first?.newFaults?.count, 1)
        let dir = repo.appendingPathComponent("system/faults")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        XCTAssertEqual(files.count, 1)
        let text = files.first.flatMap { try? String(contentsOf: dir.appendingPathComponent($0)) } ?? ""
        XCTAssertTrue(text.contains("test:\(ledgerAttempts.first?.newFaults?.first ?? "?")"), text)
    }

    private func artifactConfig(severity: LoopStageSeverity = .blocking) -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "g1", name: "Generate", kind: .skill, order: 0, skillId: "skills/plan-director"),
            LoopStage(id: "c1", name: "Check", kind: .artifactCheck, order: 1, severity: severity,
                      check: ArtifactCheckSpec(requiredPaths: ["PLAN.md"],
                                               lineLimits: [.init(glob: "PLAN.md", maxLines: 5)]))
        ], maxIterations: 4, consecutiveFailureStop: 2)
    }

    func testFailedBlockingCheckReRunsTheGenerateStageWithFindingsThenSucceeds() async throws {
        let repo = try makeTempRepo()
        let executor = WritingSkillExecutor { call in
            // First pass writes nothing; the retry writes a valid file.
            if call == 2 { try "ok\n".write(to: repo.appendingPathComponent("PLAN.md"), atomically: true, encoding: .utf8) }
        }
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: executor, approvals: makeApprovals())
        let result = await runner.run(config: artifactConfig(), faultsRoot: repo, gitRoot: repo)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(executor.messages.count, 2)
        XCTAssertFalse(executor.messages[0].contains("failed these automatic checks"))
        XCTAssertTrue(executor.messages[1].contains("missing: PLAN.md"), executor.messages[1])
        XCTAssertEqual(runner.iteration, 2)
    }

    func testPersistentlyFailingBlockingCheckStopsOnNoProgress() async throws {
        let repo = try makeTempRepo()
        let executor = WritingSkillExecutor { _ in }
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: executor, approvals: makeApprovals())
        let result = await runner.run(config: artifactConfig(), faultsRoot: repo, gitRoot: repo)
        XCTAssertEqual(result, .givenUp(reason: .noProgress(stageName: "Check")))
        XCTAssertEqual(executor.messages.count, 2, "bounded — not one generate pass per iteration forever")
    }

    func testAdvisoryCheckFailureNeverGatesTheRun() async throws {
        let repo = try makeTempRepo()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: WritingSkillExecutor { _ in }, approvals: makeApprovals())
        let result = await runner.run(config: artifactConfig(severity: .advisory), faultsRoot: repo, gitRoot: repo)
        XCTAssertEqual(result, .success)
    }

    /// A second Plan run whose skill errored: the check passes on the FIRST
    /// run's stale files, which says nothing about this run — `.error`.
    func testErroredSkillWithAPassingCheckOnStaleFilesIsError() async throws {
        let repo = try makeTempRepo()
        try "ok\n".write(to: repo.appendingPathComponent("PLAN.md"), atomically: true, encoding: .utf8)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: WritingSkillExecutor { _ in throw SkillError() }, approvals: makeApprovals())
        let result = await runner.run(config: artifactConfig(), faultsRoot: repo, gitRoot: repo)
        guard case .error(let message)? = result else { return XCTFail("got \(String(describing: result))") }
        XCTAssertTrue(message.contains("never ran cleanly"), message)
        // Advisory checks are not evidence.
        let advisory = await makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: WritingSkillExecutor { _ in throw SkillError() }, approvals: makeApprovals())
            .run(config: artifactConfig(severity: .advisory), faultsRoot: repo, gitRoot: repo)
        if case .error = advisory {} else { XCTFail("advisory check must not vouch for an errored skill: \(advisory)") }
    }

    /// A blocking shell stage that refuses repair fails the run at once: no flake
    /// re-run, no repair agent call, and the message names the stage.
    func testBlockingShellStageThatDisallowsRepairFailsWithoutRepairOrFlakeRerun() async {
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "build broke") }
        let repairer = StubRepairer()
        var build = LoopStage(id: "b1", name: "Build", kind: .shellCommand, command: "swift build", order: 0)
        build.allowsRepair = false
        let config = LoopEngineConfig(stages: [build], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("b1", "swift build")]))
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .error("stage Build failed and does not allow repair"))
        XCTAssertEqual(repairer.repairCount, 0)
        XCTAssertEqual(verifier.calls.count, 1, "the flake re-run must be skipped too")
    }

    /// Without a rescanner in this build, a snapshot stage is advisory by nature:
    /// it logs that the graph is unavailable and passes.
    func testCodeGraphSnapshotWithoutRescannerPasses() async {
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "g1", name: "Graph", kind: .codeGraph, order: 0, graphOp: .snapshot)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(), approvals: makeApprovals())
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
    }

    /// Verify with no snapshot to compare against logs and passes; it never
    /// fails for want of a baseline.
    func testCodeGraphVerifyWithoutSnapshotPasses() async {
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "g1", name: "Graph Check", kind: .codeGraph, order: 0, graphOp: .verify)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(), approvals: makeApprovals())
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .success)
    }

    /// Without a rescanner this build has no code graph, so a graph.json left on
    /// disk by an earlier build is never compared: verify passes, names the batch
    /// as not verified, and records no delta.
    func testCodeGraphVerifyWithoutRescannerNeverComparesAStaleGraph() async throws {
        let root = try writeRefactorPlan()
        defer { try? FileManager.default.removeItem(at: root) }
        let planURL = root.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let graphDir = root.appendingPathComponent("system/graph", isDirectory: true)
        try FileManager.default.createDirectory(at: graphDir, withIntermediateDirectories: true)
        try Data(Self.graphJSON(loc: 600).utf8).write(to: graphDir.appendingPathComponent("graph.json"))
        let skills = WritingSkillExecutor { _ in
            try Self.refactorPlanText.replacingOccurrences(of: "(status: todo)", with: "(status: done)")
                .write(to: planURL, atomically: true, encoding: .utf8)
        }
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: makeApprovals(approve: [("t1", "swift test")]))
        let result = await runner.run(config: refactorConfig(), faultsRoot: root, gitRoot: root)

        XCTAssertEqual(result, .success)
        let verify = try XCTUnwrap(runner.iterationRecords.flatMap(\.attempts).last(where: { $0.stageId == "g2" }))
        XCTAssertTrue(verify.passed)
        XCTAssertEqual(verify.outputTail, "code graph not available in this build; batch R1 not verified")
        XCTAssertNil(verify.graphDelta)
        XCTAssertEqual(verify.batchId, "R1")
    }

    // MARK: - Refactor next batch (the test writer's Input)

    private static let refactorPlanForNextBatch = """
    # Refactor plan

    ### R1 Split the parser (status: done)
    - Files: `a.swift`

    ### R2 Move helpers (status: todo)
    - Files: `b.swift`
    - Expect: fileCount 10 → 9

    ### R3 Rename things (status: todo)
    - Files: `c.swift`

    """

    private func nextBatchConfig() -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "w1", name: "Refactor Test Write", kind: .skill, order: 0,
                      skillId: "skills/test-gap-writer",
                      targetPath: LoopOutputLayout.refactorNextBatch, outputPath: "."),
            LoopStage(id: "t1", name: "Test Baseline", kind: .shellCommand, command: "swift test", order: 1,
                      allowsRepair: false),
        ], maxIterations: 1, consecutiveFailureStop: 2)
    }

    /// Approvals are hashed by repo path, so the temp repo needs its own grant for the baseline command.
    private func nextBatchApprovals(_ repo: URL) -> VerifyApprovalStore {
        let store = VerifyApprovalStore(defaults: UserDefaults(suiteName: "next-batch-\(UUID().uuidString)")!)
        store.approveStage(repo: repo, stageId: "t1", command: "swift test")
        return store
    }

    /// The writer's Input is the plan's first todo batch, verbatim, and nothing else.
    func testNextBatchFileHoldsOnlyTheFirstTodoBatchVerbatim() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.refactorPlanForNextBatch])
        let skillExecutor = StubSkillExecutor()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skillExecutor, approvals: nextBatchApprovals(repo))
        _ = await runner.run(config: nextBatchConfig(), faultsRoot: repo, gitRoot: repo)
        let next = (try? String(contentsOf: repo.appendingPathComponent(LoopOutputLayout.refactorNextBatch),
                                encoding: .utf8)) ?? ""
        let log = runner.log.map(\.text).joined(separator: "\n")
        XCTAssertTrue(next.hasPrefix("### R2 Move helpers (status: todo)"), "NEXT-BATCH.md: \(next)\n\(log)")
        XCTAssertTrue(next.contains("- Expect: fileCount 10 → 9"))
        XCTAssertFalse(next.contains("### R1"))
        XCTAssertFalse(next.contains("### R3"))
        XCTAssertEqual(skillExecutor.callCount, 1)
    }

    /// A split layout: the project root (`system/project.json`) holds the plan,
    /// and the git repo sits at `<project>/code/app`. Returns (project, repo).
    private func splitProjectWithRepo(plan: String?) throws -> (URL, URL) {
        let parent = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("split-project-\(UUID().uuidString)", isDirectory: true)
        let project = parent
        let staged = try TempRepo.make(files: ["a.swift": "let a = 1\n"])
        try FileManager.default.createDirectory(at: project.appendingPathComponent("code"), withIntermediateDirectories: true)
        let repo = project.appendingPathComponent("code/app", isDirectory: true)
        try FileManager.default.moveItem(at: staged, to: repo)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("system"), withIntermediateDirectories: true)
        try "{}".write(to: project.appendingPathComponent("system/project.json"), atomically: true, encoding: .utf8)
        if let plan {
            let planURL = project.appendingPathComponent(LoopOutputLayout.refactorPlan)
            try FileManager.default.createDirectory(at: planURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try plan.write(to: planURL, atomically: true, encoding: .utf8)
        }
        return (project, repo)
    }

    /// The writer reads the plan the apply stage reads: in a split layout the plan
    /// lives under the PROJECT llm-doc, and the next batch must still be selected.
    func testNextBatchFindsThePlanUnderTheProjectWhenTheRepoIsSplit() async throws {
        let (project, repo) = try splitProjectWithRepo(plan: Self.refactorPlanForNextBatch)
        defer { try? FileManager.default.removeItem(at: project) }
        let skillExecutor = StubSkillExecutor()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skillExecutor, approvals: nextBatchApprovals(repo))
        // Writer, then apply (which reads the plan), then the baseline.
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "w1", name: "Refactor Test Write", kind: .skill, order: 0,
                      skillId: "skills/test-gap-writer",
                      targetPath: LoopOutputLayout.refactorNextBatch, outputPath: "."),
            LoopStage(id: "a1", name: "Refactor Apply", kind: .skill, order: 1,
                      skillId: "skills/refactor-apply", targetPath: LoopOutputLayout.refactorPlan),
            LoopStage(id: "t1", name: "Test Baseline", kind: .shellCommand, command: "swift test", order: 2,
                      allowsRepair: false),
        ], maxIterations: 1, consecutiveFailureStop: 2)
        _ = await runner.run(config: config, faultsRoot: project, gitRoot: repo)
        let next = (try? String(contentsOf: repo.appendingPathComponent(LoopOutputLayout.refactorNextBatch),
                                encoding: .utf8)) ?? ""
        let log = runner.log.map(\.text).joined(separator: "\n")
        XCTAssertTrue(next.hasPrefix("### R2 Move helpers (status: todo)"), "NEXT-BATCH.md: \(next)\n\(log)")
        XCTAssertEqual(skillExecutor.callCount, 2, "the writer and the apply both ran")
    }

    /// No plan at either level: the writer FAILS (never skips) and names the path.
    func testNextBatchFailsWhenThePlanIsMissing() async throws {
        let (project, repo) = try splitProjectWithRepo(plan: nil)
        defer { try? FileManager.default.removeItem(at: project) }
        let skillExecutor = StubSkillExecutor()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skillExecutor, approvals: nextBatchApprovals(repo))
        let result = await runner.run(config: nextBatchConfig(), faultsRoot: project, gitRoot: repo)
        guard case .error(let message) = result else {
            return XCTFail("expected an error, got \(result)")
        }
        XCTAssertTrue(message.hasPrefix("refactor plan not found at "), message)
        XCTAssertTrue(message.hasSuffix("; cannot select the next batch"), message)
        XCTAssertEqual(skillExecutor.callCount, 0, "the agent must not run without a batch")
        XCTAssertFalse(runner.log.contains { $0.text.contains("no todo batch") })
    }

    /// No todo batch left: the writer passes as a skip and the agent is never called.
    func testWithNoTodoBatchTheWriterSkipsWithoutCallingTheAgent() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan:
            "### R1 Split the parser (status: done)\n- Files: `a.swift`\n"])
        let skillExecutor = StubSkillExecutor()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skillExecutor, approvals: nextBatchApprovals(repo))
        let result = await runner.run(config: nextBatchConfig(), faultsRoot: repo, gitRoot: repo)
        XCTAssertEqual(result, .success)
        XCTAssertEqual(skillExecutor.callCount, 0)
        XCTAssertTrue(runner.log.contains { $0.text.contains("no todo batch") })
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: repo.appendingPathComponent(LoopOutputLayout.refactorNextBatch).path))
    }

    // MARK: - Refactor graph loop: snapshot once, verify against that snapshot

    /// Serves graph fixtures in order: the first rescan (the snapshot) gets
    /// `first`, every later rescan gets `later`. Writes them where the runner reads.
    private final class FixtureRescanner: GraphRescanning {
        let first: String
        let later: String
        private(set) var calls = 0
        init(first: String, later: String) { self.first = first; self.later = later }
        func rescan(repoRoot: URL) async -> GraphRescanOutcome {
            calls += 1
            let dir = repoRoot.appendingPathComponent("system/graph", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? Data((calls == 1 ? first : later).utf8).write(to: dir.appendingPathComponent("graph.json"))
            return .rewritten
        }
    }

    /// A one-file graph whose only counter that matters here is `filesOver500Count`
    /// (a file is over 500 lines when `loc` is).
    private static func graphJSON(loc: Int) -> String {
        #"{"version":"1.1","files":[{"path":"big.swift","language":"swift","loc":\#(loc),"imports":[],"usedBy":[],"types":[],"functions":[]}],"calls":[]}"#
    }

    private static let refactorPlanText = """
    ### R1 Split Big  (status: todo)
    - Files: `big.swift`
    - Expect: filesOver500Count 1 → 0
    """

    /// Writes the plan under the test repo root and returns the root (which the
    /// caller removes). Approvals in these tests key on `repoRoot`, so the repo
    /// must be `repoRoot`.
    private func writeRefactorPlan() throws -> URL {
        let planURL = repoRoot.appendingPathComponent(LoopOutputLayout.refactorPlan)
        try FileManager.default.createDirectory(at: planURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Self.refactorPlanText.write(to: planURL, atomically: true, encoding: .utf8)
        return repoRoot
    }

    private func refactorConfig() -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "g1", name: "Graph Snapshot", kind: .codeGraph, order: 0, graphOp: .snapshot),
            LoopStage(id: "a1", name: "Apply", kind: .skill, order: 1,
                      skillId: "skills/refactor-apply", targetPath: LoopOutputLayout.refactorPlan),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 2),
            LoopStage(id: "g2", name: "Graph Check", kind: .codeGraph, order: 3, graphOp: .verify),
        ], maxIterations: 2, consecutiveFailureStop: 2)
    }

    /// Snapshot -> apply (flips R1 to `applied`) -> test fails once then passes ->
    /// verify. The failure is repaired, so the run re-enters the pipeline from the
    /// top: the snapshot must NOT be retaken, and verify must compare against the
    /// FIRST snapshot, so the delta reflects the changed graph.
    func testRefactorVerifyComparesAgainstTheFirstSnapshotAcrossAnIteration() async throws {
        let root = try writeRefactorPlan()
        defer { try? FileManager.default.removeItem(at: root) }
        let planURL = root.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let rescanner = FixtureRescanner(first: Self.graphJSON(loc: 600), later: Self.graphJSON(loc: 300))
        let skills = WritingSkillExecutor { _ in
            try Self.refactorPlanText.replacingOccurrences(of: "(status: todo)", with: "(status: done)")
                .write(to: planURL, atomically: true, encoding: .utf8)
        }
        var testCalls = 0
        let verifier = StubVerifier { _ in
            testCalls += 1
            return testCalls <= 2 ? VerifyOutcome(exitCode: 1, output: "1 failing")
                                  : VerifyOutcome(exitCode: 0, output: "")
        }
        let runner = makeRunner(
            verifier: verifier, stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: makeApprovals(approve: [("t1", "swift test")]),
            graphRescanner: rescanner)
        let result = await runner.run(config: refactorConfig(), faultsRoot: root, gitRoot: root)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(rescanner.calls, 2, "one snapshot rescan, one verify rescan")
        XCTAssertEqual(skills.messages.count, 1, "the apply stage is not re-applied")
        let before = try String(contentsOf: root.appendingPathComponent(LoopOutputLayout.refactorGraphBefore), encoding: .utf8)
        XCTAssertTrue(before.contains("\"loc\":600"), "the baseline is the first snapshot")
        let verify = try XCTUnwrap(runner.iterationRecords.flatMap(\.attempts)
            .last(where: { $0.stageId == "g2" && $0.passed }))
        XCTAssertEqual(verify.batchId, "R1")
        XCTAssertEqual(verify.graphDelta?["filesOver500Count"], -1)
    }

    /// A batch the apply stage marks skipped has nothing to verify: verify passes
    /// with that message and does not compare graphs.
    func testRefactorBatchMarkedSkippedPassesVerifyWithNothingToVerify() async throws {
        let root = try writeRefactorPlan()
        defer { try? FileManager.default.removeItem(at: root) }
        let planURL = root.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let rescanner = FixtureRescanner(first: Self.graphJSON(loc: 600), later: Self.graphJSON(loc: 600))
        let skills = WritingSkillExecutor { _ in
            try Self.refactorPlanText.replacingOccurrences(of: "(status: todo)", with: "(status: skipped, reason: intended)")
                .write(to: planURL, atomically: true, encoding: .utf8)
        }
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: makeApprovals(approve: [("t1", "swift test")]),
            graphRescanner: rescanner)
        let result = await runner.run(config: refactorConfig(), faultsRoot: root, gitRoot: root)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(rescanner.calls, 1, "only the snapshot rescans; a skipped batch is not verified")
        let verify = try XCTUnwrap(runner.iterationRecords.flatMap(\.attempts).last(where: { $0.stageId == "g2" }))
        XCTAssertTrue(verify.passed)
        XCTAssertEqual(verify.outputTail, "batch R1 was skipped; nothing to verify")
    }

    // MARK: - Refactor batch rollback (Mikado, design doc §3.5, §5)

    /// A scripted working tree: an edit appends paths to `pending`, and the next
    /// `snapshotTree` turns them into a new tree id (`t<n>`), so
    /// `treeDiff(from:to:)` reports exactly what changed between two snapshots —
    /// including a "user" edit made between stages, which no agent window owns.
    /// Records every `restore` instead of touching a disk.
    private final class TreeScriptGuard: RepairScopeGuarding {
        var pending: [String] = []
        /// steps[k] = the paths that turned tree `t<k>` into `t<k+1>`.
        private var steps: [[String]] = []
        private(set) var restores: [(paths: [String], tree: String)] = []
        /// The deletion allowlist each `restore` was handed.
        private(set) var deletables: [Set<String>] = []
        /// Paths the base tree "does not have" (the batch created them): the fake
        /// leaves one alone unless it is in the `deletable` set, as the real guard does.
        var absentPaths: Set<String> = []
        /// When set, every `snapshotTree` fails (no git), so no batch base exists.
        var failSnapshots = false
        func snapshotTree(gitRoot: URL) async -> String? {
            if failSnapshots { return nil }
            if !pending.isEmpty {
                steps.append(pending)
                pending = []
            }
            return "t\(steps.count)"
        }
        func treeDiff(from: String, to: String, gitRoot: URL, maxChars: Int,
                      isQuotable: (String) -> Bool) async -> RepairDiffSummary? {
            guard let a = Int(from.dropFirst()), let b = Int(to.dropFirst()), a <= b, b <= steps.count else {
                return nil
            }
            return RepairDiffSummary(changedPaths: Array(Set(steps[a..<b].flatMap { $0 })).sorted())
        }
        func snapshot(gitRoot: URL, protectedGlobs: [String], scopeGlobs: [String]) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck {
            .clean(changedPaths: [])
        }
        func restore(paths: [String], fromTree tree: String, gitRoot: URL) async -> String? {
            restores.append((paths, tree))
            return nil
        }
        func restore(paths: [String], fromTree tree: String, gitRoot: URL,
                     deletable: Set<String>) async -> RestoreResult {
            await restore(groups: [tree: paths], gitRoot: gitRoot, deletable: deletable)
        }
        /// Records one entry per source tree, as the real multi-tree restore performs one per group.
        func restore(groups: [String: [String]], gitRoot: URL, deletable: Set<String>) async -> RestoreResult {
            var out = RestoreResult()
            deletables.append(deletable)
            for tree in groups.keys.sorted() {
                let paths = groups[tree] ?? []
                restores.append((paths, tree))
                let left = paths.filter { absentPaths.contains($0) && !deletable.contains($0) }
                out.leftAlone += left
                out.changed += paths.filter { !left.contains($0) }
            }
            return out
        }
        func revert(paths: [String], gitRoot: URL) async -> String? { nil }
    }

    /// Plays each refactor skill against `TreeScriptGuard`: the test writer adds
    /// a test; the apply marks R1 done in the real plan file and edits two
    /// sources (and the plan — which a rollback must never restore).
    private final class BatchSkillExecutor: LoopSkillExecuting {
        let tree: TreeScriptGuard
        let planURL: URL
        /// Whether the test writer reports `Tests/R1Tests.swift` as created.
        let reportsCreatedTest: Bool
        /// Where a reporting writer puts its test: under `rollbackRepoWithTestRoot`'s test root.
        static let rootedTestPath = "Tests/R1Tests/R1Tests.swift"
        /// The apply stage also edits `Sources/A.swift` (and the baseline may
        /// have a user save of it just before).
        private(set) var skillIds: [String] = []
        init(tree: TreeScriptGuard, planURL: URL, reportsCreatedTest: Bool = false) {
            self.tree = tree
            self.planURL = planURL
            self.reportsCreatedTest = reportsCreatedTest
        }
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
            skillIds.append(skillId)
            switch skillId {
            case "skills/test-gap-writer":
                tree.pending.append(reportsCreatedTest ? Self.rootedTestPath : "Tests/R1Tests.swift")
                if reportsCreatedTest {
                    return LoopAgentResult(changedPaths: [Self.rootedTestPath], createdPaths: [Self.rootedTestPath])
                }
            case "skills/refactor-apply":
                let plan = try String(contentsOf: planURL, encoding: .utf8)
                try plan.replacingOccurrences(of: "(status: todo)", with: "(status: done)")
                    .write(to: planURL, atomically: true, encoding: .utf8)
                tree.pending.append(contentsOf: ["Sources/A.swift", "Sources/B.swift", LoopOutputLayout.refactorPlan])
            default:
                break
            }
            return LoopAgentResult()
        }
    }

    /// Each repair edits its own source file (`Sources/C<n>.swift`).
    private final class BatchRepairer: LoopStageRepairer {
        let tree: TreeScriptGuard
        private(set) var repairCount = 0
        init(tree: TreeScriptGuard) { self.tree = tree }
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
            repairCount += 1
            tree.pending.append("Sources/C\(repairCount).swift")
            return LoopAgentResult()
        }
    }

    private static let rollbackPlan = """
    ### R1 Split Big  (status: todo)
    - Files: `Sources/A.swift`, `Sources/B.swift`

    """

    /// Test Write → Test Baseline → Apply → Test, as the default refactor loop
    /// orders them (`plan` puts a planner stage first).
    private func rollbackConfig(plan: Bool = false) -> LoopEngineConfig {
        var stages = [
            LoopStage(id: "w1", name: "Refactor Test Write", kind: .skill, order: 1,
                      skillId: "skills/test-gap-writer",
                      targetPath: LoopOutputLayout.refactorNextBatch, outputPath: "."),
            LoopStage(id: "b1", name: "Test Baseline", kind: .shellCommand, command: "swift build", order: 2,
                      allowsRepair: false),
            LoopStage(id: "a1", name: "Refactor Apply", kind: .skill, order: 3,
                      skillId: "skills/refactor-apply", targetPath: LoopOutputLayout.refactorPlan, outputPath: "."),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 4),
        ]
        if plan {
            stages.insert(LoopStage(id: "p1", name: "Refactor Plan", kind: .skill, order: 0,
                                    skillId: "skills/refactor-planner", targetPath: ".",
                                    outputPath: LoopOutputLayout.refactorPlan), at: 0)
        }
        return LoopEngineConfig(stages: stages, maxIterations: 10, consecutiveFailureStop: 10,
                                maxRepairsPerStage: 5)
    }

    private func rollbackApprovals(_ repo: URL) -> VerifyApprovalStore {
        let store = VerifyApprovalStore(defaults: UserDefaults(suiteName: "rollback-\(UUID().uuidString)")!)
        store.approveStage(repo: repo, stageId: "b1", command: "swift build")
        store.approveStage(repo: repo, stageId: "t1", command: "swift test")
        return store
    }

    /// The batch's Test keeps failing after repairs, so the run gives up: the
    /// rollback restores EXACTLY the union of what the batch's own stages changed
    /// (test write, apply, every repair) from the base taken before the test
    /// writer — never the plan, and never a path the user edited between stages
    /// — and marks the batch blocked in the plan, the journal and the summary.
    func testGivingUpAfterRepairsRestoresExactlyTheBatchsOwnEditsAndMarksItBlocked() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.rollbackPlan])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        // Every shell run "coincides" with a user edit outside any agent window.
        let verifier = StubVerifier { command in
            tree.pending.append("notes/user.txt")
            return command == "swift test" ? VerifyOutcome(exitCode: 1, output: "1 failing")
                                           : VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let repairer = BatchRepairer(tree: tree)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: BatchSkillExecutor(tree: tree, planURL: planURL),
            approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: rollbackConfig(), faultsRoot: repo, gitRoot: repo)

        guard case .givenUp = result else { return XCTFail("expected a give-up, got \(String(describing: result))") }
        XCTAssertGreaterThanOrEqual(repairer.repairCount, 2)
        let expected = ["Sources/A.swift", "Sources/B.swift"]
            + (1...repairer.repairCount).map { "Sources/C\($0).swift" } + ["Tests/R1Tests.swift"]
        // One restore per source tree: each path goes back to how it was just
        // before the first batch edit that touched it.
        XCTAssertEqual(tree.restores.flatMap(\.paths).sorted(), expected.sorted())
        XCTAssertEqual(tree.restores.first(where: { $0.paths.contains("Tests/R1Tests.swift") })?.tree, "t0",
                       "the writer's file is restored to the base taken before the test writer")

        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("### R1 Split Big  (status: blocked)"), plan)
        XCTAssertTrue(plan.contains("- Blocked: Test — given up"), plan)
        let log = runner.log.map(\.text)
        XCTAssertTrue(log.contains("R1 rolled back; tree restored to before the batch"), log.joined(separator: "\n"))
        let rollback = try XCTUnwrap(journal.written.last?.batchRollback)
        XCTAssertEqual(rollback.batchId, "R1")
        XCTAssertEqual(rollback.stageName, "Test")
        XCTAssertTrue(rollback.treeRestored)
        XCTAssertNil(rollback.problem)
        XCTAssertEqual(rollback.restoredPaths, expected.sorted())
        XCTAssertEqual(runner.batchRollback, rollback)
        XCTAssertTrue(rollback.summary.hasPrefix("R1 rolled back (blocked: Test — given up"), rollback.summary)
        let note = NoteLoopRunSummaryWriter.render(try XCTUnwrap(journal.written.last), title: "t")
        XCTAssertTrue(note.contains("**Rollback:** R1 rolled back (blocked: Test — given up"), note)
    }

    /// A file changed after the batch's last recorded edit — the user saving
    /// `Sources/A.swift` while the final Test ran — is not the batch's to undo:
    /// the rollback leaves it alone, reports it, and does not call the tree
    /// restored. Only the test file the agent REPORTED creating may be deleted.
    func testRollbackLeavesPathsChangedAfterTheLastEditAloneAndDeletesOnlyReportedCreations() async throws {
        let repo = try rollbackRepoWithTestRoot()
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = BatchSkillExecutor(tree: tree, planURL: planURL, reportsCreatedTest: true)
        // The test root's own command is also run by the baseline (written roots),
        // so "swift test" may only go red once Apply has run.
        let verifier = StubVerifier { command in
            if command == "swift test", skills.skillIds.contains("skills/refactor-apply") {
                tree.pending.append("Sources/A.swift")  // the user's save, outside any agent window
                return VerifyOutcome(exitCode: 1, output: "1 failing")
            }
            return VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills,
            approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: rollbackConfig(), faultsRoot: repo, gitRoot: repo)

        guard case .givenUp = result else { return XCTFail("expected a give-up, got \(String(describing: result))") }
        let restored = tree.restores.flatMap(\.paths)
        XCTAssertFalse(restored.contains("Sources/A.swift"), "a path changed after the last edit is not restored")
        XCTAssertTrue(restored.contains("Sources/B.swift"))
        XCTAssertEqual(tree.deletables.first, [BatchSkillExecutor.rootedTestPath],
                       "only the creation the agent reported may be deleted")
        let rollback = try XCTUnwrap(journal.written.last?.batchRollback)
        XCTAssertFalse(rollback.treeRestored, "a rollback that left paths alone is not a clean restore")
        XCTAssertEqual(rollback.leftAlonePaths, ["Sources/A.swift"])
        XCTAssertTrue(rollback.summary.contains("PARTLY rolled back"), rollback.summary)
        XCTAssertFalse(rollback.restoredPaths.contains("Sources/A.swift"))
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("(status: blocked)"), plan)
    }

    /// A user save of an ALREADY-touched path between two agent edits: A.swift
    /// is changed by Apply, the user saves it during the first Test run, and the
    /// later repair edits only other files. A.swift changed after the batch last
    /// touched IT, so the rollback leaves it alone.
    func testRollbackLeavesAnAlreadyTouchedPathTheUserSavedBetweenEditsAlone() async throws {
        let repo = try rollbackRepoWithTestRoot()
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = BatchSkillExecutor(tree: tree, planURL: planURL, reportsCreatedTest: true)
        var saved = false
        let verifier = StubVerifier { command in
            guard command == "swift test", skills.skillIds.contains("skills/refactor-apply") else {
                return VerifyOutcome(exitCode: 0, output: "")
            }
            if !saved { saved = true; tree.pending.append("Sources/A.swift") }  // the user's save
            return VerifyOutcome(exitCode: 1, output: "1 failing")
        }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        _ = await runner.run(config: rollbackConfig(), faultsRoot: repo, gitRoot: repo)

        XCTAssertFalse(tree.restores.flatMap(\.paths).contains("Sources/A.swift"))
        XCTAssertTrue(tree.restores.flatMap(\.paths).contains("Sources/B.swift"))
        let rollback = try XCTUnwrap(journal.written.last?.batchRollback)
        XCTAssertEqual(rollback.leftAlonePaths, ["Sources/A.swift"])
        XCTAssertFalse(rollback.restoredPaths.contains("Sources/A.swift"))
    }

    /// A user save of `Sources/A.swift` during the Test Baseline — between the
    /// writer's edit and Apply's — is part of the tree Apply started from, so the
    /// rollback restores A.swift to THAT, not to the older batch base.
    func testRollbackRestoresAPathToHowItWasBeforeTheFirstBatchEditThatTouchedIt() async throws {
        let repo = try rollbackRepoWithTestRoot()
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = BatchSkillExecutor(tree: tree, planURL: planURL, reportsCreatedTest: true)
        let verifier = StubVerifier { command in
            if command == "swift build" { tree.pending.append("Sources/A.swift") }  // the user's save
            // Red only after Apply: the baseline also runs the test root's "swift test".
            return command == "swift test" && skills.skillIds.contains("skills/refactor-apply")
                ? VerifyOutcome(exitCode: 1, output: "1 failing") : VerifyOutcome(exitCode: 0, output: "")
        }
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills,
            approvals: rollbackApprovals(repo), scopeGuard: tree)
        _ = await runner.run(config: rollbackConfig(), faultsRoot: repo, gitRoot: repo)

        let aTree = try XCTUnwrap(tree.restores.first(where: { $0.paths.contains("Sources/A.swift") })?.tree)
        XCTAssertNotEqual(aTree, "t0", "A.swift is restored to the tree before Apply, which holds the user's save")
        XCTAssertEqual(tree.restores.first(where: { $0.paths.contains(BatchSkillExecutor.rootedTestPath) })?.tree, "t0")
    }

    /// A minimal SwiftPM layout so the Test Write placement guard accepts a
    /// file under `Tests/R1Tests/`.
    private func rollbackRepoWithTestRoot() throws -> URL {
        try TempRepo.make(files: [
            LoopOutputLayout.refactorPlan: Self.rollbackPlan,
            "Package.swift": ".testTarget(name: \"R1Tests\")\n",
            "Tests/R1Tests/Keep.swift": "// keep\n",
        ])
    }

    /// Without a report that the agent created the test file (the shipped
    /// scripted executor reports nothing), nothing may be deleted.
    func testRollbackDeletesNothingTheAgentDidNotReportCreating() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.rollbackPlan])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let verifier = StubVerifier { command in
            command == "swift test" ? VerifyOutcome(exitCode: 1, output: "1 failing")
                                    : VerifyOutcome(exitCode: 0, output: "")
        }
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: BatchSkillExecutor(tree: tree, planURL: planURL),
            approvals: rollbackApprovals(repo), scopeGuard: tree)
        _ = await runner.run(config: rollbackConfig(), faultsRoot: repo, gitRoot: repo)
        XCTAssertEqual(tree.deletables.first, [])
    }

    /// A Stop (`.aborted`) is the user stepping in to look: the applied batch
    /// stays exactly as it is — no restore, and the plan is not marked blocked.
    func testAnAbortedRunNeverRollsTheBatchBack() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.rollbackPlan])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let verifier = StubVerifier { command in
            if command == "swift test" { throw CancellationError() }
            return VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: BatchSkillExecutor(tree: tree, planURL: planURL),
            approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: rollbackConfig(), faultsRoot: repo, gitRoot: repo)

        XCTAssertEqual(result, .aborted)
        XCTAssertEqual(runner.currentBatchId, "R1", "the batch was applied before the Stop")
        XCTAssertTrue(tree.restores.isEmpty, "a Stop never restores the tree")
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("(status: done)"), plan)
        XCTAssertFalse(plan.contains("blocked"), plan)
        XCTAssertNil(journal.written.last?.batchRollback)
    }

    /// A failed Graph Check ends the run through the same funnel and rolls the
    /// batch back. With no test writer in the run, the base is taken before Apply.
    func testAFailedGraphCheckRollsTheBatchBack() async throws {
        let root = try writeRefactorPlan()
        defer { try? FileManager.default.removeItem(at: root) }
        let planURL = root.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        // The graph does not change, so R1's promised `filesOver500Count` fall never happens.
        let rescanner = FixtureRescanner(first: Self.graphJSON(loc: 600), later: Self.graphJSON(loc: 600))
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: BatchRepairer(tree: tree), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: BatchSkillExecutor(tree: tree, planURL: planURL),
            approvals: makeApprovals(approve: [("t1", "swift test")]), scopeGuard: tree,
            graphRescanner: rescanner)
        let result = await runner.run(config: refactorConfig(), faultsRoot: root, gitRoot: root)

        guard case .error(let message) = result else { return XCTFail("expected an error, got \(String(describing: result))") }
        XCTAssertTrue(message.contains("promised"), message)
        XCTAssertEqual(tree.restores.first?.paths, ["Sources/A.swift", "Sources/B.swift"])
        XCTAssertEqual(tree.restores.first?.tree, "t0")
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("(status: blocked)"), plan)
        XCTAssertTrue(plan.contains("- Blocked: Graph Check — error: batch R1 promised"), plan)
    }

    /// A stage that passes after its repair restarts the pipeline at the batch's
    /// first stage, not stage 0: the planner never re-plans mid-batch (§5.7).
    func testPassingAfterARepairRestartsAtTheBatchNotThePlanner() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.rollbackPlan])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        var testRuns = 0
        let verifier = StubVerifier { command in
            guard command == "swift test" else { return VerifyOutcome(exitCode: 0, output: "") }
            testRuns += 1
            // Fails, fails the flake re-run, then passes after the repair.
            return testRuns <= 2 ? VerifyOutcome(exitCode: 1, output: "1 failing") : VerifyOutcome(exitCode: 0, output: "")
        }
        let skills = BatchSkillExecutor(tree: tree, planURL: planURL)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), scopeGuard: tree)
        let result = await runner.run(config: rollbackConfig(plan: true), faultsRoot: repo, gitRoot: repo)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(skills.skillIds.filter { $0 == "skills/refactor-planner" }.count, 1,
                       "the planner ran once, before the batch")
        XCTAssertEqual(skills.skillIds.filter { $0 == "skills/refactor-apply" }.count, 1)
        XCTAssertTrue(runner.log.contains { $0.text.contains("re-running the batch from Refactor Test Write") })
        XCTAssertTrue(tree.restores.isEmpty, "a verified batch is never rolled back")
        XCTAssertNil(runner.batchRollback)
    }

    /// A run that ends between the test writer and Apply (here a red Test
    /// Baseline, which may not repair) still rolls back: the writer's new tests
    /// leave the tree, or every later run's baseline would be red too. With no
    /// batch applied yet, the batch is the plan's first todo one (§5.1, §5.5).
    /// A red baseline says nothing about the batch, so the batch goes back to
    /// `todo` rather than `blocked` — the planner must not write `- Replaces:`
    /// batches around a "blocker" that was never in it.
    func testARedBaselineAfterTheWriterRollsTheWritersTestsBack() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.rollbackPlan])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let verifier = StubVerifier { command in
            command == "swift build" ? VerifyOutcome(exitCode: 1, output: "1 failing")
                                     : VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let skills = BatchSkillExecutor(tree: tree, planURL: planURL)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: rollbackConfig(), faultsRoot: repo, gitRoot: repo)

        guard case .error = result else { return XCTFail("expected an error, got \(String(describing: result))") }
        XCTAssertFalse(skills.skillIds.contains("skills/refactor-apply"), "Apply never ran")
        XCTAssertNil(runner.currentBatchId)
        XCTAssertEqual(tree.restores.first?.paths, ["Tests/R1Tests.swift"])
        XCTAssertEqual(tree.restores.first?.tree, "t0")
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("### R1 Split Big  (status: todo)"), plan)
        XCTAssertFalse(plan.contains("blocked"), plan)
        XCTAssertFalse(plan.contains("- Blocked:"), plan)
        let rollback = try XCTUnwrap(journal.written.last?.batchRollback)
        XCTAssertEqual(rollback.batchId, "R1")
        XCTAssertEqual(rollback.treeRestored, true)
        XCTAssertEqual(rollback.backToTodo, true)
        XCTAssertTrue(rollback.summary.hasPrefix("R1 rolled back (back to todo: Test Baseline — error:"),
                      rollback.summary)
        XCTAssertTrue(runner.log.contains { $0.text.hasPrefix("R1 back to todo in the refactor plan") })
    }

    /// Test Write → Test Baseline → Check Baseline → Apply → Check → Test, the
    /// default refactor loop's batch with a lint/typecheck command detected.
    private func checkedRollbackConfig() -> LoopEngineConfig {
        let stages = [
            LoopStage(id: "w1", name: "Refactor Test Write", kind: .skill, order: 1,
                      skillId: "skills/test-gap-writer",
                      targetPath: LoopOutputLayout.refactorNextBatch, outputPath: "."),
            LoopStage(id: "b1", name: "Test Baseline", kind: .shellCommand, command: "swift test", order: 2,
                      allowsRepair: false),
            LoopStage(id: "cb", name: "Check Baseline", kind: .shellCommand, command: "make lint", order: 3,
                      allowsRepair: false),
            LoopStage(id: "a1", name: "Refactor Apply", kind: .skill, order: 4,
                      skillId: "skills/refactor-apply", targetPath: LoopOutputLayout.refactorPlan, outputPath: "."),
            LoopStage(id: "c1", name: "Check", kind: .shellCommand, command: "make lint", order: 5),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 6),
        ]
        return LoopEngineConfig(stages: stages, maxIterations: 10, consecutiveFailureStop: 10,
                                maxRepairsPerStage: 5)
    }

    private func checkedRollbackApprovals(_ repo: URL) -> VerifyApprovalStore {
        let store = VerifyApprovalStore(defaults: UserDefaults(suiteName: "rollback-\(UUID().uuidString)")!)
        store.approveStage(repo: repo, stageId: "b1", command: "swift test")
        store.approveStage(repo: repo, stageId: "cb", command: "make lint")
        store.approveStage(repo: repo, stageId: "c1", command: "make lint")
        store.approveStage(repo: repo, stageId: "t1", command: "swift test")
        return store
    }

    /// Records which stage each repair was for, in order.
    private final class StageNamingRepairer: LoopStageRepairer {
        private(set) var stageNames: [String] = []
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
            stageNames.append(stageName)
            return LoopAgentResult()
        }
    }

    /// A red Check Baseline (the repo's lint was already broken before the
    /// batch) ends the run before Apply. The writer's tests are rolled back,
    /// and the batch goes back to `todo`, not `blocked`: nothing about the
    /// batch is implicated, so it is retried as-is next run.
    func testARedCheckBaselineRollsTheBatchBackToTodo() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.rollbackPlan])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let verifier = StubVerifier { command in
            command == "make lint" ? VerifyOutcome(exitCode: 1, output: "3 lint errors")
                                   : VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let skills = BatchSkillExecutor(tree: tree, planURL: planURL)
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: checkedRollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: checkedRollbackConfig(), faultsRoot: repo, gitRoot: repo)

        guard case .error = result else { return XCTFail("expected an error, got \(String(describing: result))") }
        XCTAssertFalse(skills.skillIds.contains("skills/refactor-apply"), "Apply never ran")
        XCTAssertEqual(tree.restores.first?.paths, ["Tests/R1Tests.swift"], "the writer's tests leave the tree")
        XCTAssertEqual(tree.restores.first?.tree, "t0")
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("### R1 Split Big  (status: todo)"), plan)
        XCTAssertFalse(plan.contains("blocked"), plan)
        let rollback = try XCTUnwrap(journal.written.last?.batchRollback)
        XCTAssertEqual(rollback.stageName, "Check Baseline")
        XCTAssertEqual(rollback.backToTodo, true)
        XCTAssertTrue(rollback.treeRestored)
        let note = NoteLoopRunSummaryWriter.render(try XCTUnwrap(journal.written.last), title: "t")
        XCTAssertTrue(note.contains("**Rollback:** R1 rolled back (back to todo: Check Baseline — error:"), note)
    }

    /// A transport error in a batch-scope repair is infrastructure, not the
    /// batch: rolled back to `todo`. A failed Graph Check (the batch moved the
    /// structure the wrong way) stays `blocked` — see
    /// `testAFailedGraphCheckRollsTheBatchBack`.
    func testARepairTransportErrorRollsTheBatchBackToTodo() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.rollbackPlan])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let verifier = StubVerifier { command in
            command == "swift test" ? VerifyOutcome(exitCode: 1, output: "1 failing")
                                    : VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: ThrowingRepairer(error: APIError.network(URLError(.cannotConnectToHost))),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: BatchSkillExecutor(tree: tree, planURL: planURL),
            approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: rollbackConfig(), faultsRoot: repo, gitRoot: repo)

        guard case .error = result else { return XCTFail("expected an error, got \(String(describing: result))") }
        XCTAssertTrue(tree.restores.flatMap(\.paths).contains("Sources/A.swift"),
                      "the applied batch is still taken back out")
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("### R1 Split Big  (status: todo)"), "Apply's done is undone: \(plan)")
        XCTAssertEqual(journal.written.last?.batchRollback?.backToTodo, true)
    }

    /// Mid-batch restarts never re-run the baselines (§5.7). Apply breaks both
    /// the lint and the tests; Check is repaired, passes, and the batch
    /// restarts at its first stage. Re-run there, Test Baseline would measure
    /// the half-repaired batch — tests still red — and, unable to repair, end
    /// the run before Test ever got its own repair. Skipped instead, Test is
    /// reached, repaired, and the batch is verified.
    func testARestartAfterACheckRepairSkipsTheBaselinesAndLetsTestRepair() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.rollbackPlan])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = BatchSkillExecutor(tree: tree, planURL: planURL)
        let repairer = StageNamingRepairer()
        let verifier = StubVerifier { command in
            let applied = skills.skillIds.contains("skills/refactor-apply")
            let fixed: Bool
            switch command {
            case "make lint": fixed = repairer.stageNames.contains("Check")
            case "swift test": fixed = repairer.stageNames.contains("Test")
            default: fixed = true
            }
            return applied && !fixed ? VerifyOutcome(exitCode: 1, output: "1 failing")
                                     : VerifyOutcome(exitCode: 0, output: "")
        }
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: checkedRollbackApprovals(repo), scopeGuard: tree)
        let result = await runner.run(config: checkedRollbackConfig(), faultsRoot: repo, gitRoot: repo)

        XCTAssertEqual(result, .success, runner.log.map(\.text).joined(separator: "\n"))
        XCTAssertEqual(repairer.stageNames, ["Check", "Test"], "Check and then Test each got their own repair")
        let attempts = runner.iterationRecords.flatMap(\.attempts)
        XCTAssertEqual(attempts.filter { $0.stageId == "b1" }.count, 1, "Test Baseline ran only on the first pass")
        XCTAssertEqual(attempts.filter { $0.stageId == "cb" }.count, 1, "Check Baseline ran only on the first pass")
        XCTAssertEqual(skills.skillIds.filter { $0 == "skills/refactor-apply" }.count, 1)
        XCTAssertTrue(runner.log.contains { $0.text.contains("[Test Baseline] already passed before this batch was applied") })
        XCTAssertTrue(tree.restores.isEmpty, "a verified batch is never rolled back")
        XCTAssertEqual(runner.stageStates["b1"], .passed)
    }

    /// No base (git could not snapshot the tree): nothing can be restored, but
    /// the failed batch is still marked blocked — left `done`, the next run
    /// would stack another batch onto it — and the record says the tree was
    /// NOT restored.
    func testWithNoBaseTheFailedBatchIsStillMarkedBlocked() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.rollbackPlan])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        tree.failSnapshots = true
        let verifier = StubVerifier { command in
            command == "swift test" ? VerifyOutcome(exitCode: 1, output: "1 failing")
                                    : VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: BatchSkillExecutor(tree: tree, planURL: planURL),
            approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: rollbackConfig(), faultsRoot: repo, gitRoot: repo)

        guard case .givenUp = result else { return XCTFail("expected a give-up, got \(String(describing: result))") }
        XCTAssertTrue(tree.restores.isEmpty, "there is no base to restore from")
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("(status: blocked)"), plan)
        let rollback = try XCTUnwrap(journal.written.last?.batchRollback)
        XCTAssertEqual(rollback.batchId, "R1")
        XCTAssertFalse(rollback.treeRestored)
        XCTAssertTrue(rollback.problem?.contains("no snapshot of the tree") == true, rollback.problem ?? "nil")
        XCTAssertFalse(runner.log.contains { $0.text == "R1 rolled back; tree restored to before the batch" })
    }

    /// Resolution 1's trigger set: every unsuccessful ending rolls back, except
    /// those where a human is deliberately in the loop.
    func testRollbackTriggerClassification() {
        let rollsBack: [LoopEngineStatus] = [
            .givenUp(reason: .maxIterations), .givenUp(reason: .repeatedFailure),
            .givenUp(reason: .noProgress(stageName: "Test")), .givenUp(reason: .wallClockExceeded),
            .givenUp(reason: .repairBudgetExhausted(stageName: "Test")),
            .givenUp(reason: .stoppedReporting(stageName: "Test")), .givenUp(reason: .regressionStalled),
            .blocked(reason: .repairOutOfScope(stageName: "Test", paths: ["Tests/a"])),
            .blocked(reason: .environment(stageName: "Test", detail: "no node")),
            .error("structure regressed"),
        ]
        for status in rollsBack {
            XCTAssertTrue(LoopEngineRunner.rollsBackBatch(status), status.summary)
        }
        for status: LoopEngineStatus in [.success, .aborted, .needsApproval(stageName: "Test")] {
            XCTAssertFalse(LoopEngineRunner.rollsBackBatch(status), status.summary)
        }
    }

    // MARK: - Several refactor batches per run (design doc §3.6, §5.3, §5.4)

    /// Plays a plan of several batches: the writer adds `Tests/<id>Tests.swift`
    /// for the plan's first todo batch; Apply marks that batch done and edits
    /// `Sources/<id>.swift` (and the plan). `appliedIds` is every batch Apply applied.
    private final class MultiBatchSkillExecutor: LoopSkillExecuting {
        let planURL: URL
        let tree: TreeScriptGuard?
        /// Skills whose agent call fails with a refused connection (the stage errors).
        var refusing: Set<String> = []
        private(set) var skillIds: [String] = []
        private(set) var appliedIds: [String] = []
        init(planURL: URL, tree: TreeScriptGuard? = nil) {
            self.planURL = planURL
            self.tree = tree
        }
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
            skillIds.append(skillId)
            if refusing.contains(skillId) { throw APIError.network(URLError(.cannotConnectToHost)) }
            let plan = try String(contentsOf: planURL, encoding: .utf8)
            guard let id = RefactorPlanDiff.firstTodo(in: plan)?.id else { return LoopAgentResult() }
            switch skillId {
            case "skills/test-gap-writer":
                tree?.pending.append("Tests/\(id)Tests.swift")
            case "skills/refactor-apply":
                let marked = plan.components(separatedBy: "\n").map { line in
                    line.hasPrefix("### \(id) ")
                        ? line.replacingOccurrences(of: "(status: todo)", with: "(status: done)") : line
                }.joined(separator: "\n")
                try marked.write(to: planURL, atomically: true, encoding: .utf8)
                appliedIds.append(id)
                tree?.pending.append(contentsOf: ["Sources/\(id).swift", LoopOutputLayout.refactorPlan])
            default:
                break
            }
            return LoopAgentResult()
        }
    }

    private static func multiBatchPlan(_ count: Int) -> String {
        (1...count).map { "### R\($0) Batch \($0)  (status: todo)\n- Files: `Sources/R\($0).swift`\n" }
            .joined(separator: "\n")
    }

    /// Planner → Test Write → Test Baseline → Apply → Test (`rollbackConfig(plan: true)`).
    private func multiBatchConfig(batchesPerRun: Int?, maxIterations: Int = 10,
                                  maxRepairsPerStage: Int = 5) -> LoopEngineConfig {
        var config = rollbackConfig(plan: true)
        config.maxIterations = maxIterations
        config.maxRepairsPerStage = maxRepairsPerStage
        config.refactorBatchesPerRun = batchesPerRun
        return config
    }

    private func writersRun(_ skills: MultiBatchSkillExecutor) -> Int {
        skills.skillIds.filter { $0 == "skills/test-gap-writer" }.count
    }

    /// A verified batch moves the run on to the plan's next todo batch — at the
    /// batch's first stage, never back to the planner — until the run's limit
    /// (3 by default); the rest of the plan waits for the next run.
    func testAVerifiedBatchStartsTheNextOneUpToTheLimit() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.multiBatchPlan(4)])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = MultiBatchSkillExecutor(planURL: planURL, tree: tree)
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: BatchRepairer(tree: tree), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: multiBatchConfig(batchesPerRun: nil), faultsRoot: repo, gitRoot: repo)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(skills.appliedIds, ["R1", "R2", "R3"], "nil means 3 batches per run")
        XCTAssertEqual(skills.skillIds.filter { $0 == "skills/refactor-planner" }.count, 1,
                       "the planner is not re-run between batches")
        XCTAssertEqual(writersRun(skills), 3, "each batch writes its own tests")
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("### R3 Batch 3  (status: done)"), plan)
        XCTAssertTrue(plan.contains("### R4 Batch 4  (status: todo)"), "the fourth batch waits for the next run")
        XCTAssertTrue(tree.restores.isEmpty, "verified batches are never rolled back")
        XCTAssertEqual(runner.iteration, 3, "one iteration per batch, numbered across the run")
        XCTAssertEqual(journal.written.last?.appliedBatches, ["R1", "R2", "R3"])
        XCTAssertNil(journal.written.last?.skippedBatches)
        XCTAssertEqual(runner.batchesSummary, "Applied: R1, R2, R3")
        let log = runner.log.map(\.text)
        XCTAssertTrue(log.contains { $0.hasPrefix("R1 done — starting batch R2 (2 of at most 3 this run") },
                      log.joined(separator: "\n"))
        XCTAssertTrue(log.contains("Batch limit reached (3 per run)"), log.joined(separator: "\n"))
    }

    /// `refactorBatchesPerRun: 1` is the one-batch-per-run behaviour from before.
    func testOneBatchPerRunStopsAfterTheFirstBatch() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.multiBatchPlan(2)])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = MultiBatchSkillExecutor(planURL: planURL, tree: tree)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: BatchRepairer(tree: tree), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), scopeGuard: tree)
        let result = await runner.run(config: multiBatchConfig(batchesPerRun: 1), faultsRoot: repo, gitRoot: repo)

        XCTAssertEqual(result, .success)
        XCTAssertEqual(skills.appliedIds, ["R1"])
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("### R2 Batch 2  (status: todo)"), plan)
        XCTAssertFalse(runner.log.contains { $0.text.contains("starting batch") })
    }

    /// Iterations, the repair streak and per-stage repair counts start over for
    /// each batch (§5.4). With 2 iterations and 1 repair per stage, each batch
    /// needs both (fail, repair, pass); counted per run the second batch would
    /// have neither.
    func testIterationsAndRepairCountsStartOverForEachBatch() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.multiBatchPlan(2)])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = MultiBatchSkillExecutor(planURL: planURL, tree: tree)
        let repairer = BatchRepairer(tree: tree)
        // Each apply breaks the tests until the next repair fixes them. In each
        // batch: fail, fail the flake re-run (the gate is per batch, like the
        // repair count), repair, pass. The re-run costs no iteration.
        let verifier = StubVerifier { command in
            guard command == "swift test", skills.appliedIds.count > repairer.repairCount else {
                return VerifyOutcome(exitCode: 0, output: "")
            }
            return VerifyOutcome(exitCode: 1, output: "1 failing")
        }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer, regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(
            config: multiBatchConfig(batchesPerRun: nil, maxIterations: 2, maxRepairsPerStage: 1),
            faultsRoot: repo, gitRoot: repo)

        XCTAssertEqual(result, .success, runner.log.map(\.text).joined(separator: "\n"))
        XCTAssertEqual(skills.appliedIds, ["R1", "R2"])
        XCTAssertEqual(repairer.repairCount, 2, "one repair per batch, each within its own budget of 1")
        XCTAssertEqual(runner.iteration, 4, "2 iterations per batch, numbered across the run")
        XCTAssertEqual(runner.runMaxIterations, 4, "the ceiling moved to the second batch's own 2")
        XCTAssertEqual(journal.written.last?.appliedBatches, ["R1", "R2"])
        XCTAssertEqual(skills.skillIds.filter { $0 == "skills/refactor-planner" }.count, 1)
    }

    /// A LATER batch that fails is rolled back on its own — only its edits,
    /// from its own base — and marked blocked; the run still succeeds with the
    /// verified batch (§5.3), lists both, and attempts no further batch (§3.6).
    func testALaterBatchRolledBackStillSucceedsWithTheVerifiedOnes() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.multiBatchPlan(3)])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = MultiBatchSkillExecutor(planURL: planURL, tree: tree)
        let repairer = BatchRepairer(tree: tree)
        // R2's tests never pass, whatever the repairs do.
        let verifier = StubVerifier { command in
            command == "swift test" && skills.appliedIds.last == "R2"
                ? VerifyOutcome(exitCode: 1, output: "1 failing") : VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: repairer, regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: multiBatchConfig(batchesPerRun: nil), faultsRoot: repo, gitRoot: repo)

        XCTAssertEqual(result, .success, runner.log.map(\.text).joined(separator: "\n"))
        XCTAssertEqual(skills.appliedIds, ["R1", "R2"], "a blocked batch ends the run; R3 is not attempted")
        XCTAssertGreaterThanOrEqual(repairer.repairCount, 1)
        let expected = (["Sources/R2.swift", "Tests/R2Tests.swift"]
            + (1...max(repairer.repairCount, 1)).map { "Sources/C\($0).swift" }).sorted()
        // One restore per first-touch tree: compare the union across calls.
        XCTAssertEqual(tree.restores.flatMap(\.paths).sorted(), expected, "only R2's own edits, never R1's")
        XCTAssertFalse(tree.restores.contains { $0.tree == "t0" }, "R2's own trees, taken after R1 was verified")

        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("### R1 Batch 1  (status: done)"), plan)
        XCTAssertTrue(plan.contains("### R2 Batch 2  (status: blocked)"), plan)
        XCTAssertTrue(plan.contains("- Blocked: Test — given up"), plan)
        XCTAssertTrue(plan.contains("### R3 Batch 3  (status: todo)"), plan)

        let record = try XCTUnwrap(journal.written.last)
        XCTAssertEqual(record.statusCode, LoopEngineStatus.success.code)
        XCTAssertEqual(record.appliedBatches, ["R1"])
        XCTAssertEqual(record.batchRollback?.batchId, "R2")
        XCTAssertEqual(record.batchRollback?.treeRestored, true)
        let summary = try XCTUnwrap(runner.batchesSummary)
        XCTAssertTrue(summary.hasPrefix("Applied: R1 · Rolled back: R2 (blocked: Test — given up"), summary)
        let note = NoteLoopRunSummaryWriter.render(record, title: "t")
        XCTAssertTrue(note.contains("**Batches:** Applied: R1 · Rolled back: R2 (blocked: Test — given up"), note)
        XCTAssertFalse(note.contains("**Rollback:**"), "the batch list already names the rollback: \(note)")
        XCTAssertTrue(runner.log.contains { $0.text.hasPrefix("Keeping the 1 verified batch(es) (R1)") })
    }

    /// With nothing verified this run, a rollback still fails the run, and no
    /// further batch is attempted.
    func testAFirstBatchRolledBackFailsTheRunAndStartsNoOther() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.multiBatchPlan(3)])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = MultiBatchSkillExecutor(planURL: planURL, tree: tree)
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { command in
                command == "swift test" ? VerifyOutcome(exitCode: 1, output: "1 failing") : VerifyOutcome(exitCode: 0, output: "")
            },
            stageRepairer: BatchRepairer(tree: tree), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: multiBatchConfig(batchesPerRun: nil), faultsRoot: repo, gitRoot: repo)

        guard case .givenUp = result else { return XCTFail("expected a give-up, got \(String(describing: result))") }
        XCTAssertEqual(skills.appliedIds, ["R1"])
        XCTAssertNil(journal.written.last?.appliedBatches)
        XCTAssertEqual(journal.written.last?.batchRollback?.batchId, "R1")
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("### R2 Batch 2  (status: todo)"), plan)
    }

    /// A later batch that fails but CANNOT be taken back out of the tree (its
    /// edits could not all be tracked) keeps the failure: the tree holds an
    /// unverified batch, which must never ship as a success.
    func testALaterBatchLeftInTheTreeKeepsTheRunFailed() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.multiBatchPlan(2)])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = MultiBatchSkillExecutor(planURL: planURL, tree: tree)
        // From R2's baseline on, git can no longer snapshot: R2's base exists,
        // but its Apply leaves a tracking gap, so the rollback restores nothing.
        let verifier = StubVerifier { command in
            if self.writersRun(skills) >= 2 { tree.failSnapshots = true }
            return command == "swift test" && skills.appliedIds.last == "R2"
                ? VerifyOutcome(exitCode: 1, output: "1 failing") : VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: multiBatchConfig(batchesPerRun: nil), faultsRoot: repo, gitRoot: repo)

        guard case .givenUp = result else { return XCTFail("expected a give-up, got \(String(describing: result))") }
        let record = try XCTUnwrap(journal.written.last)
        XCTAssertEqual(record.appliedBatches, ["R1"])
        XCTAssertEqual(record.batchRollback?.batchId, "R2")
        XCTAssertEqual(record.batchRollback?.treeRestored, false)
        XCTAssertTrue(tree.restores.isEmpty)
        XCTAssertTrue(runner.batchesSummary?.hasPrefix("Applied: R1 · Not rolled back: R2") == true,
                      runner.batchesSummary ?? "nil")
    }

    /// The planner's agent call errors in batch 1 (it proceeds, recorded
    /// `errored`), and R1 is verified. No batch 2 may start: the planner never
    /// re-runs after batch 1, so the error could never clear, and R2 failing
    /// and being rolled back would otherwise let `keepingVerifiedBatches` turn
    /// the run's honest `.error` into `.success` — hiding the planner's error.
    /// Here R2's tests would fail, so without the guard this run would succeed.
    func testAnErroredStageBeforeTheBatchStopsTheRunAndKeepsItsError() async throws {
        let repo = try TempRepo.make(files: [LoopOutputLayout.refactorPlan: Self.multiBatchPlan(3)])
        defer { try? FileManager.default.removeItem(at: repo) }
        let planURL = repo.appendingPathComponent(LoopOutputLayout.refactorPlan)
        let tree = TreeScriptGuard()
        let skills = MultiBatchSkillExecutor(planURL: planURL, tree: tree)
        skills.refusing = ["skills/refactor-planner"]
        let verifier = StubVerifier { command in
            command == "swift test" && skills.appliedIds.last == "R2"
                ? VerifyOutcome(exitCode: 1, output: "1 failing") : VerifyOutcome(exitCode: 0, output: "")
        }
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: verifier, stageRepairer: BatchRepairer(tree: tree),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: rollbackApprovals(repo), journal: journal, scopeGuard: tree)
        let result = await runner.run(config: multiBatchConfig(batchesPerRun: nil), faultsRoot: repo, gitRoot: repo)

        guard case .error(let message) = result else {
            return XCTFail("expected an error, got \(String(describing: result))")
        }
        XCTAssertTrue(message.contains("Refactor Plan"), message)
        XCTAssertEqual(skills.appliedIds, ["R1"], "no batch 2 after an errored stage")
        XCTAssertEqual(runner.stageStates["p1"], .errored)
        XCTAssertTrue(runner.log.contains { $0.text.hasPrefix("Not starting another batch: a stage's agent call errored") })
        XCTAssertTrue(tree.restores.isEmpty, "R1 was verified; nothing failed to roll back")
        let plan = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(plan.contains("### R1 Batch 1  (status: done)"), plan)
        XCTAssertTrue(plan.contains("### R2 Batch 2  (status: todo)"), plan)
        let record = try XCTUnwrap(journal.written.last)
        XCTAssertEqual(record.appliedBatches, ["R1"])
        XCTAssertNil(record.batchRollback)
        XCTAssertNotEqual(record.statusCode, LoopEngineStatus.success.code)
    }

    /// Serves `graphs` in rescan order (the last one repeats), where the runner reads them.
    private final class SequenceRescanner: GraphRescanning {
        let graphs: [String]
        private(set) var calls = 0
        init(_ graphs: [String]) { self.graphs = graphs }
        func rescan(repoRoot: URL) async -> GraphRescanOutcome {
            let graph = graphs[min(calls, graphs.count - 1)]
            calls += 1
            let dir = repoRoot.appendingPathComponent("system/graph", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? Data(graph.utf8).write(to: dir.appendingPathComponent("graph.json"))
            return .rewritten
        }
    }

    private static func twoFileGraphJSON(locA: Int, locB: Int) -> String {
        func file(_ path: String, _ loc: Int) -> String {
            #"{"path":"\#(path)","language":"swift","loc":\#(loc),"imports":[],"usedBy":[],"types":[],"functions":[]}"#
        }
        return #"{"version":"1.1","files":[\#(file("a.swift", locA)),\#(file("b.swift", locB))],"calls":[]}"#
    }

    /// Each batch's Graph Check is measured against the state the previous
    /// batch's check verified, not the run's first snapshot (§3.6): R2's
    /// counter falls by one, not by the two both batches together removed.
    func testTheNextBatchIsMeasuredAgainstTheVerifiedGraph() async throws {
        let planURL = repoRoot.appendingPathComponent(LoopOutputLayout.refactorPlan)
        try FileManager.default.createDirectory(at: planURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repoRoot) }
        try """
        ### R1 Split A  (status: todo)
        - Files: `a.swift`
        - Expect: filesOver500Count 2 → 1

        ### R2 Split B  (status: todo)
        - Files: `b.swift`
        - Expect: filesOver500Count 1 → 0
        """.write(to: planURL, atomically: true, encoding: .utf8)
        let rescanner = SequenceRescanner([Self.twoFileGraphJSON(locA: 600, locB: 600),
                                           Self.twoFileGraphJSON(locA: 300, locB: 600),
                                           Self.twoFileGraphJSON(locA: 300, locB: 300)])
        let skills = MultiBatchSkillExecutor(planURL: planURL)
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(), regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skills, approvals: makeApprovals(approve: [("t1", "swift test")]),
            graphRescanner: rescanner)
        let result = await runner.run(config: refactorConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)

        XCTAssertEqual(result, .success, runner.log.map(\.text).joined(separator: "\n"))
        XCTAssertEqual(skills.appliedIds, ["R1", "R2"])
        XCTAssertEqual(rescanner.calls, 3, "one snapshot, one check per batch")
        let checks = runner.iterationRecords.flatMap(\.attempts).filter { $0.stageId == "g2" && $0.passed }
        XCTAssertEqual(checks.map(\.batchId), ["R1", "R2"])
        XCTAssertEqual(checks.map { $0.graphDelta?["filesOver500Count"] }, [-1, -1])
    }
}

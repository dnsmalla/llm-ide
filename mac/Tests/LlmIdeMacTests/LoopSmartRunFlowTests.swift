import XCTest
@testable import LlmIdeMacLib

/// Task 3.3: flake gate, stop rules, stage-only re-verify, repair model tier.
@MainActor
final class LoopSmartRunFlowTests: XCTestCase {

    override func tearDown() {
        LoopRunQueue._resetForTesting()
        LoopWorktreeManager._resetForTesting()
        super.tearDown()
    }

    private let repoRoot = URL(fileURLWithPath: "/tmp/smart-\(UUID().uuidString)")

    /// Scripted verifier: each command consumes its own queue of (exit, output);
    /// the last entry repeats once the queue is exhausted.
    final class Verifier: FaultVerifier {
        var script: [String: [(Int32, String)]]
        private(set) var calls: [String] = []
        init(_ script: [String: [(Int32, String)]]) { self.script = script }
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            calls.append(command)
            var q = script[command] ?? [(0, "")]
            let next = q.count > 1 ? q.removeFirst() : q[0]
            script[command] = q
            return VerifyOutcome(exitCode: next.0, output: next.1)
        }
    }

    final class Repairer: LoopStageRepairer {
        private(set) var models: [String?] = []
        private(set) var count = 0
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
            count += 1
            return LoopAgentResult(reply: "r\(count)")
        }
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?,
                    model: String?) async throws -> LoopAgentResult {
            models.append(model)
            return try await repair(stageName: stageName, command: command, failureOutput: failureOutput,
                                    evidence: evidence, repoRoot: repoRoot, timeout: timeout)
        }
    }

    final class Skills: LoopSkillExecuting {
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
            LoopAgentResult()
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
        func loadRecord(id: String, startedAt: Date, root: URL) -> LoopRunRecord? { nil }
    }

    final class Summary: LoopRunSummaryWriting {
        func write(_ record: LoopRunRecord, root: URL) async -> LoopSummaryNoteResult { .written(path: "x.md") }
    }

    /// Each repair "changes" a different file so successive diffs differ.
    final class Guard: RepairScopeGuarding {
        var constantDiff = false
        private var snaps = 0
        func snapshot(gitRoot: URL, protectedGlobs: [String], scopeGlobs: [String]) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck {
            .clean(changedPaths: ["Sources/A.swift"])
        }
        func revert(paths: [String], gitRoot: URL) async -> String? { nil }
        func snapshotTree(gitRoot: URL) async -> String? { snaps += 1; return "tree\(snaps)" }
        func treeDiff(from: String, to: String, gitRoot: URL, maxChars: Int,
                      isQuotable: (String) -> Bool) async -> RepairDiffSummary? {
            RepairDiffSummary(changedPaths: ["Sources/A.swift"], stat: "1 file", diff: constantDiff ? "+same" : "+diff \(to)")
        }
    }

    private func config(stop: Int = 3, repairs: Int = 5, model: String? = nil) -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "b", name: "Build", kind: .shellCommand, command: "build", order: 0),
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "test", order: 1),
        ], maxIterations: 6, consecutiveFailureStop: stop, maxRepairsPerStage: repairs, repairModel: model)
    }

    private func run(_ config: LoopEngineConfig, verifier: Verifier, repairer: Repairer,
                     journal: Journal = Journal(), constantDiff: Bool = false) async -> LoopEngineStatus? {
        let scope = Guard()
        scope.constantDiff = constantDiff
        let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: "smart-\(UUID().uuidString)")!)
        approvals.approveStage(repo: repoRoot, stageId: "b", command: "build")
        approvals.approveStage(repo: repoRoot, stageId: "t", command: "test")
        let r = LoopEngineRunner(verifier: verifier, stageRepairer: repairer, regressionSweep: Sweep(),
                                 skillExecutor: Skills(), approvals: approvals, stageTimeout: 60,
                                 journal: journal, summaryWriter: Summary(), scopeGuard: scope,
                                 transportRetryDelay: 0)
        return await r.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
    }

    private func xc(_ failing: [String]) -> String {
        failing.map { "Test Case '-[M.C \($0)]' failed (0.1 seconds)." }.joined(separator: "\n")
            + "\nExecuted 5 tests, with \(failing.count) failures (0 unexpected) in 0.1 (0.1) seconds"
    }

    // MARK: - Flake gate

    func testFlakeIsJournaledAndNeverRepaired() async {
        let v = Verifier(["test": [(1, xc(["a"])), (0, "")]])
        let rep = Repairer(), journal = Journal()
        let status = await run(config(), verifier: v, repairer: rep, journal: journal)
        XCTAssertEqual(status, .success)
        XCTAssertEqual(rep.count, 0)
        let notes = journal.written.flatMap(\.iterations).flatMap(\.attempts).compactMap(\.agentNote)
        XCTAssertTrue(notes.contains { $0.contains("flaky") })
    }

    func testFlakeGateRunsOnlyBeforeFirstRepair() async {
        // fail, fail (real) -> repair -> fail, fail ... : verify calls for the
        // gate happen once, never again after the first repair.
        let v = Verifier(["test": [(1, xc(["a"])), (1, xc(["a"])), (0, "")]])
        let rep = Repairer()
        let status = await run(config(), verifier: v, repairer: rep)
        XCTAssertEqual(status, .success)
        XCTAssertEqual(rep.count, 1)
        XCTAssertEqual(v.calls.filter { $0 == "test" }.count, 4) // fail, gate, post-repair pass, full rerun
    }

    // MARK: - Re-verify only the failed stage

    func testAfterRepairOnlyFailedStageRerunsThenFullPipeline() async {
        let v = Verifier(["test": [(1, xc(["a"])), (1, xc(["a"])), (0, "")]])
        let rep = Repairer()
        _ = await run(config(), verifier: v, repairer: rep)
        // build, test(fail), test(gate), [repair], test(pass) , build, test
        XCTAssertEqual(v.calls, ["build", "test", "test", "test", "build", "test"])
    }

    // MARK: - Stop rules

    func testPartialFixIsNeutralAndDoesNotCountTowardStop() {
        var w = ProgressWatch()
        _ = w.record(key: "t", score: 2, hash: "h1", ids: ["a", "b"])
        let v = w.record(key: "t", score: 2, hash: "h2", ids: ["b", "c"])
        XCTAssertTrue(v.neutral)
        XCTAssertFalse(v.improved)
        XCTAssertEqual(v.streak, 1)
        let same = w.record(key: "t", score: 2, hash: "h2", ids: ["b", "c"])
        XCTAssertFalse(same.neutral)
        XCTAssertEqual(same.streak, 2)
    }

    func testSameFailureAfterTwoDifferentDiffsStopsEarly() async {
        // Constant failure; the Guard makes every diff different.
        let v = Verifier(["test": [(1, xc(["a"]))]])
        let rep = Repairer()
        let status = await run(config(stop: 9, repairs: 9), verifier: v, repairer: rep)
        XCTAssertEqual(status, .givenUp(reason: .repeatedFailure))
        XCTAssertEqual(rep.count, 2)
    }

    func testLedgerHelperNeedsTwoDifferentDiffsFromTheCurrentFailure() {
        func e(_ n: Int, _ diff: String, _ before: String) -> LoopLedgerEntry {
            LoopLedgerEntry(n: n, changedPaths: ["f.swift"], diffStat: "", diff: diff,
                            replySummary: "", failureSetBefore: before)
        }
        XCTAssertTrue(LoopAttemptLedger.returnedAfterDifferentDiffs([e(1, "+a", "X"), e(2, "+b", "X")], current: "X"))
        XCTAssertFalse(LoopAttemptLedger.returnedAfterDifferentDiffs([e(1, "+a", "X"), e(2, "+a", "X")], current: "X"))
        XCTAssertFalse(LoopAttemptLedger.returnedAfterDifferentDiffs([e(1, "+a", "Y"), e(2, "+b", "X")], current: "X"))
        XCTAssertFalse(LoopAttemptLedger.returnedAfterDifferentDiffs([e(1, "+a", "X")], current: "X"))
    }

    func testFirstNoProgressVerdictStillGetsOneInformedRepairAtStopTwo() async {
        // Identical failure and identical diffs (so the two-diffs rule stays out
        // of it), stop=2: the first no-progress verdict still gets one more
        // (informed) repair, then the run gives up.
        let v = Verifier(["test": [(1, xc(["a"]))]])
        let rep = Repairer()
        let status = await run(config(stop: 2, repairs: 9), verifier: v, repairer: rep, constantDiff: true)
        XCTAssertEqual(status, .givenUp(reason: .noProgress(stageName: "Test")))
        XCTAssertEqual(rep.count, 2)
    }

    // MARK: - Fix round 1

    func testFlakyPassIsFlaggedOnTheAttemptAndInTheSummary() async {
        let v = Verifier(["test": [(1, xc(["a"])), (0, "")]])
        let journal = Journal()
        _ = await run(config(), verifier: v, repairer: Repairer(), journal: journal)
        let record = journal.written[0]
        XCTAssertTrue(record.iterations.flatMap(\.attempts).contains { $0.flaky == true })
        XCTAssertTrue(NoteLoopRunSummaryWriter.render(record, title: "t").contains("Possibly flaky"))
    }

    func testRepairIsShownTheRerunsOutputWhenItFailedDifferently() async {
        final class Seeing: LoopStageRepairer {
            var outputs: [String] = []
            func repair(stageName: String, command: String?, failureOutput: String,
                        evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
                outputs.append(failureOutput); return LoopAgentResult()
            }
        }
        let v = Verifier(["test": [(1, xc(["a"])), (1, xc(["b"])), (0, "")]])
        let rep = Seeing()
        let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: "smart-\(UUID().uuidString)")!)
        approvals.approveStage(repo: repoRoot, stageId: "b", command: "build")
        approvals.approveStage(repo: repoRoot, stageId: "t", command: "test")
        let r = LoopEngineRunner(verifier: v, stageRepairer: rep, regressionSweep: Sweep(),
                                 skillExecutor: Skills(), approvals: approvals, stageTimeout: 60,
                                 journal: Journal(), summaryWriter: Summary(), scopeGuard: Guard(),
                                 transportRetryDelay: 0)
        _ = await r.run(config: config(), faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(rep.outputs.count, 1)
        XCTAssertTrue(rep.outputs[0].contains("C b]"))
        XCTAssertFalse(rep.outputs[0].contains("C a]"))
    }

    func testGrowingFailureSetIsNotNeutral() {
        var w = ProgressWatch()
        _ = w.record(key: "t", score: 2, hash: "h1", ids: ["a", "b"])
        let v = w.record(key: "t", score: nil, hash: "h2", ids: ["b", "c", "d"])
        XCTAssertFalse(v.neutral)
        XCTAssertEqual(v.streak, 2)
    }

    func testEachRepairRoundIsChargedAsAnIteration() async {
        let v = Verifier(["test": [(1, xc(["a"]))]])
        let rep = Repairer()
        let cfg = LoopEngineConfig(stages: config().stages, maxIterations: 3, consecutiveFailureStop: 9,
                                   maxRepairsPerStage: 9)
        let status = await run(cfg, verifier: v, repairer: rep, constantDiff: true)
        XCTAssertEqual(status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(rep.count, 2, "maxIterations-1 repair rounds, as before")
    }

    func testBuiltInTemplatesStopAfterThree() {
        for t in LoopTemplate.builtIns { XCTAssertEqual(t.config.consecutiveFailureStop, 3, t.name) }
    }

    // MARK: - Model tier + defaults

    func testRepairModelIsPassedToTheRepairer() async {
        let v = Verifier(["test": [(1, xc(["a"])), (1, xc(["a"])), (0, "")]])
        let rep = Repairer()
        _ = await run(config(model: "haiku"), verifier: v, repairer: rep)
        XCTAssertEqual(rep.models, ["haiku"])
    }

    func testRepairModelDefaultsToNilAndOldConfigsDecode() throws {
        XCTAssertNil(LoopEngineConfig(stages: []).repairModel)
        let json = #"{"stages":[],"maxIterations":4,"consecutiveFailureStop":2}"#
        let decoded = try JSONDecoder().decode(LoopEngineConfig.self, from: Data(json.utf8))
        XCTAssertNil(decoded.repairModel)
        XCTAssertEqual(decoded.consecutiveFailureStop, 2)
    }

    func testNewLoopDefaultStopIsThreeButPersistedValuesAreKept() {
        let d = UserDefaults(suiteName: "smartdef-\(UUID().uuidString)")!
        XCTAssertEqual(LoopEngineDefaults.load(defaults: d).consecutiveFailureStop, 3)
        var saved = LoopEngineConfig(stages: []); saved.consecutiveFailureStop = 2
        LoopEngineDefaults.save(saved, defaults: d)
        XCTAssertEqual(LoopEngineDefaults.load(defaults: d).consecutiveFailureStop, 2)
    }
}

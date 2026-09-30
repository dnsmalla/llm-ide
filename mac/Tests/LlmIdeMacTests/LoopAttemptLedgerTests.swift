import XCTest
@testable import LlmIdeMacLib

/// Task 3.2: the per-stage attempt ledger — what each repair did, fed into the
/// next repair prompt and into the next run that meets the same failure set.
@MainActor
final class LoopAttemptLedgerTests: XCTestCase {

    override func tearDown() {
        LoopRunQueue._resetForTesting()
        LoopWorktreeManager._resetForTesting()
        super.tearDown()
    }

    private let repoRoot = URL(fileURLWithPath: "/tmp/ledger-\(UUID().uuidString)")

    // MARK: - Stubs

    final class Verifier: FaultVerifier {
        var output: String
        init(_ output: String) { self.output = output }
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            VerifyOutcome(exitCode: 1, output: output)
        }
    }

    final class Repairer: LoopStageRepairer {
        private(set) var evidence: [RepairEvidence?] = []
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
            self.evidence.append(evidence)
            return LoopAgentResult(reply: "reply \(self.evidence.count)")
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
        var previous: LoopRunRecord?
        func write(_ record: LoopRunRecord, root: URL) -> String? { written.append(record); return nil }
        func recentRuns(root: URL, limit: Int) -> [LoopRunIndexEntry] {
            previous.map { [LoopRunIndexEntry($0)] } ?? []
        }
        func loadRecord(id: String, startedAt: Date, root: URL) -> LoopRunRecord? { previous }
    }

    final class Summary: LoopRunSummaryWriting {
        func write(_ record: LoopRunRecord, root: URL) async -> LoopSummaryNoteResult { .written(path: "x.md") }
    }

    final class Guard: RepairScopeGuarding {
        private(set) var diffPaths: [[String]] = []
        func snapshot(gitRoot: URL, protectedGlobs: [String], scopeGlobs: [String]) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck {
            .clean(changedPaths: ["Sources/A.swift", ".env", "Sources/B.swift"])
        }
        func revert(paths: [String], gitRoot: URL) async -> String? { nil }
        func diffSummary(paths: [String], gitRoot: URL, maxChars: Int) async -> RepairDiffSummary {
            diffPaths.append(paths)
            return RepairDiffSummary(stat: "2 files changed", diff: "+fix")
        }
    }

    private func approvals() -> VerifyApprovalStore {
        let store = VerifyApprovalStore(defaults: UserDefaults(suiteName: "ledger-\(UUID().uuidString)")!)
        store.approveStage(repo: repoRoot, stageId: "t", command: "swift test")
        return store
    }

    private let config = LoopEngineConfig(stages: [
        LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
    ], maxIterations: 4, consecutiveFailureStop: 9)

    private func run(journal: Journal, repairer: Repairer, scope: Guard,
                     output: String = "Foo.swift:3:5: error: boom") async {
        let r = LoopEngineRunner(verifier: Verifier(output), stageRepairer: repairer, regressionSweep: Sweep(),
                                 skillExecutor: Skills(), approvals: approvals(), stageTimeout: 60,
                                 journal: journal, summaryWriter: Summary(), scopeGuard: scope,
                                 transportRetryDelay: 0)
        _ = await r.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
    }

    // MARK: - Pure ledger

    private func entry(_ n: Int, diff: String = "+x", before: String? = "h") -> LoopLedgerEntry {
        LoopLedgerEntry(n: n, changedPaths: ["a\(n).swift"], diffStat: "1 file", diff: diff,
                        replySummary: "did \(n)", failureSetBefore: before)
    }

    func testBlockKeepsLastThreeAndStaysWithinBudget() {
        let big = String(repeating: "x", count: 10_000)
        let entries = (1...6).map { entry($0, diff: big) }
        let block = LoopAttemptLedger.block(entries)
        XCTAssertLessThanOrEqual(block.count, LoopAttemptLedger.maxBlockChars)
        XCTAssertTrue(block.contains("attempt 6"))
        XCTAssertTrue(block.contains("attempt 4"))
        XCTAssertFalse(block.contains("attempt 3"))
        XCTAssertTrue(block.contains("Do something different"))
        XCTAssertEqual(LoopAttemptLedger.block([]), "")
    }

    func testEntryTrimsDiffAndReply() {
        let e = LoopLedgerEntry(n: 1, changedPaths: [], diffStat: "", diff: String(repeating: "d", count: 9_000),
                                replySummary: String(repeating: "r", count: 5_000), failureSetBefore: nil)
        XCTAssertEqual(e.diff.count, LoopLedgerEntry.maxDiffChars)
        XCTAssertEqual(e.replySummary.count, LoopLedgerEntry.maxReplyChars)
    }

    func testSecretAndProtectedPathsAreNotQuotable() {
        let globs = GitRepairScopeGuard.defaultProtectedGlobs
        for p in [".env", "app/.env.local", "keys/server.pem", "config/credentials.json", "Tests/FooTests.swift"] {
            XCTAssertTrue(LoopAttemptLedger.isUnquotable(p, protectedGlobs: globs), p)
        }
        XCTAssertFalse(LoopAttemptLedger.isUnquotable("Sources/A.swift", protectedGlobs: globs))
    }

    func testOlderAttemptRecordsWithoutALedgerStillDecode() throws {
        let attempt = LoopStageAttempt(stageId: "t", stageName: "T", kind: .shellCommand, severity: .blocking,
                                       startedAt: Date(), durationSeconds: 1, exitCode: 1, passed: false,
                                       outputTail: "x", outputHash: "h", score: 1)
        let data = try JSONEncoder().encode(attempt)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("ledger"))
        XCTAssertNil(try JSONDecoder().decode(LoopStageAttempt.self, from: data).ledger)
    }

    func testPromptCarriesTheLedger() {
        var ev = RepairEvidence(attempt: 2, previousScore: 1, currentScore: 1, improved: false, streak: 1)
        ev.ledger = [entry(1)]
        let prompt = AgentLoopStageRepairer.buildPrompt(stageName: "T", command: "c", failureOutput: "f",
                                                        repoRoot: repoRoot, evidence: ev)
        XCTAssertTrue(prompt.contains("did 1"))
        XCTAssertTrue(prompt.contains("Do something different"))
    }

    // MARK: - Runner

    func testSecondRepairSeesTheFirstAttemptAndItsOutcomeIsJournalled() async {
        let journal = Journal(), repairer = Repairer(), scope = Guard()
        await run(journal: journal, repairer: repairer, scope: scope)

        XCTAssertGreaterThanOrEqual(repairer.evidence.count, 2)
        XCTAssertEqual(repairer.evidence[0]?.ledger.count, 0)
        let seen = repairer.evidence[1]?.ledger
        XCTAssertEqual(seen?.count, 1)
        XCTAssertEqual(seen?.first?.replySummary, "reply 1")
        XCTAssertEqual(seen?.first?.diffStat, "2 files changed")
        XCTAssertEqual(seen?.first?.changedPaths, [".env", "Sources/A.swift", "Sources/B.swift"])
        XCTAssertFalse(scope.diffPaths.flatMap { $0 }.contains(".env"), "a secret path's diff is never read")

        let first = journal.written.last?.iterations.first?.attempts.first
        XCTAssertEqual(first?.ledger?.n, 1)
        XCTAssertNotNil(first?.ledger?.resultingFailureSet, "the next verification settles the entry")
        XCTAssertEqual(first?.ledger?.resultingFailureSet, first?.outputHash)
    }

    private func previousRecord(failureSet: String) -> LoopRunRecord {
        let attempt = LoopStageAttempt(
            stageId: "t", stageName: "Test", kind: .shellCommand, severity: .blocking, startedAt: Date(),
            durationSeconds: 1, exitCode: 1, passed: false, outputTail: "", outputHash: failureSet, score: 1,
            ledger: entry(1))
        return LoopRunRecord(id: "prev", projectId: nil, trigger: .manual, gitRoot: "/x", startedAt: Date(),
                             endedAt: Date(), iterationsUsed: 1, config: LoopRunConfigSnapshot(config),
                             iterations: [LoopIterationRecord(index: 1, attempts: [attempt])],
                             statusCode: "given_up", statusSummary: "gave up", loopId: "primary", loopName: "Loop")
    }

    func testNewRunInheritsThePreviousRunsAttemptsOnTheSameFailureSet() async {
        // The hash the runner itself journals for this output.
        let probe = Journal()
        await run(journal: probe, repairer: Repairer(), scope: Guard())
        let hash = probe.written.last?.iterations.first?.attempts.first?.outputHash ?? ""
        XCTAssertFalse(hash.isEmpty)
        let journal = Journal(), repairer = Repairer()
        journal.previous = previousRecord(failureSet: hash)
        await run(journal: journal, repairer: repairer, scope: Guard())
        XCTAssertEqual(repairer.evidence.first?.flatMap { $0 }?.priorRunLedger.count, 1)
        XCTAssertEqual(repairer.evidence[1]?.priorRunLedger.count, 0, "first repair only")
    }

    func testADifferentFailureSetInheritsNothing() async {
        let journal = Journal(), repairer = Repairer()
        journal.previous = previousRecord(failureSet: "some-other-failure")
        await run(journal: journal, repairer: repairer, scope: Guard())
        XCTAssertEqual(repairer.evidence.first?.flatMap { $0 }?.priorRunLedger.count, 0)
    }
}

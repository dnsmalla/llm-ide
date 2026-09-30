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
        private(set) var quotable: [String] = []
        private var snaps = 0
        func snapshot(gitRoot: URL, protectedGlobs: [String], scopeGlobs: [String]) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck {
            .clean(changedPaths: ["Sources/A.swift", ".env", "Sources/B.swift"])
        }
        func revert(paths: [String], gitRoot: URL) async -> String? { nil }
        func snapshotTree(gitRoot: URL) async -> String? { snaps += 1; return "tree\(snaps)" }
        func treeDiff(from: String, to: String, gitRoot: URL, maxChars: Int,
                      isQuotable: (String) -> Bool) async -> RepairDiffSummary? {
            let all = [".env", "Sources/A.swift", "Sources/B.swift"]
            quotable = all.filter(isQuotable)
            return RepairDiffSummary(changedPaths: all, stat: "2 files changed", diff: "+fix token=ghp_\(String(repeating: "a", count: 36))")
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
        for p in [".env", "app/.env.local", "keys/server.pem", "config/credentials.json", "Tests/FooTests.swift",
                  "secrets/a.txt", "x/.secrets/b", "credentials/c", ".envrc", "infra/prod.tfvars", ".pgpass",
                  "k/kubeconfig", "service-account-prod.json", "a.p12", "a.keystore", "home/id_rsa"] {
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
        XCTAssertEqual(scope.quotable, ["Sources/A.swift", "Sources/B.swift"], "a secret path's diff is never read")
        XCTAssertFalse(seen?.first?.diff.contains("ghp_") ?? true, "credential shapes are redacted")

        let first = journal.written.last?.iterations.first?.attempts.first(where: { $0.repairAttempted })
        XCTAssertEqual(first?.ledger?.n, 1)
        XCTAssertNotNil(first?.ledger?.resultingFailureSet, "the next verification settles the entry")
        XCTAssertEqual(first?.ledger?.resultingFailureSet, first?.outputHash)
    }

    private func previousRecord(failureSet: String) -> LoopRunRecord {
        let attempt = LoopStageAttempt(
            stageId: "t", stageName: "Test", kind: .shellCommand, severity: .blocking, startedAt: Date(),
            durationSeconds: 1, exitCode: 1, passed: false, outputTail: "", outputHash: failureSet, score: 1,
            ledger: entry(1, before: failureSet))
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

    // MARK: - Fix round 1

    func testStatAndPathListAreCapped() {
        let e = LoopLedgerEntry(n: 1, changedPaths: (1...30).map { "f\($0).swift" },
                                diffStat: String(repeating: "s", count: 2_000), diff: "", replySummary: "",
                                failureSetBefore: nil)
        XCTAssertEqual(e.diffStat.count, LoopLedgerEntry.maxStatChars)
        let block = LoopAttemptLedger.block([e])
        XCTAssertTrue(block.contains("+10 more"))
        XCTAssertFalse(block.contains("f21.swift"))
    }

    func testBlockNeverEmptyAndPriorBlockShrinksInsteadOfVanishing() {
        let huge = LoopLedgerEntry(n: 1, changedPaths: [], diffStat: "", diff: "",
                                   replySummary: String(repeating: "r", count: 1_000), failureSetBefore: nil)
        XCTAssertFalse(LoopAttemptLedger.block([huge], budget: 300).isEmpty)
        XCTAssertLessThanOrEqual(LoopAttemptLedger.block([huge], budget: 300).count, 300)
        var ev = RepairEvidence(attempt: 2, previousScore: 1, currentScore: 1, improved: false, streak: 1)
        ev.ledger = (1...3).map { entry($0, diff: String(repeating: "x", count: 4_000)) }
        ev.priorRunLedger = [entry(9, diff: String(repeating: "y", count: 4_000))]
        let prompt = AgentLoopStageRepairer.buildPrompt(stageName: "T", command: "c", failureOutput: "f",
                                                        repoRoot: repoRoot, evidence: ev)
        XCTAssertTrue(prompt.contains("attempt 9"), "prior-run block shrinks, not dropped")
        XCTAssertTrue(prompt.contains("attempt 3"))
    }

    func testPriorRunEntriesFilterByFailureSetAndPassedIsLabelled() {
        var fixed = entry(2, before: "h")
        fixed.resultingPassed = true
        let other = entry(1, before: "other")
        let attempt = LoopStageAttempt(stageId: "t", stageName: "T", kind: .shellCommand, severity: .blocking,
                                       startedAt: Date(), durationSeconds: 1, exitCode: 1, passed: false,
                                       outputTail: "", outputHash: "h", score: 1, ledger: other)
        var second = attempt; second.ledger = fixed
        var rec = previousRecord(failureSet: "h")
        rec.iterations = [LoopIterationRecord(index: 1, attempts: [attempt, second])]
        let got = LoopAttemptLedger.priorRunEntries(in: rec, stageId: "t", failureSet: "h")
        XCTAssertEqual(got.map(\.n), [2])
        XCTAssertTrue(LoopAttemptLedger.block(got, priorRun: true).contains("fixed it, but the failure returned"))
    }

    func testADifferentLoopsPriorRunIsIgnored() async {
        let probe = Journal()
        await run(journal: probe, repairer: Repairer(), scope: Guard())
        let hash = probe.written.last?.iterations.first?.attempts.first?.outputHash ?? ""
        let journal = Journal(), repairer = Repairer()
        var prev = previousRecord(failureSet: hash)
        prev.loopId = "another-loop"
        journal.previous = prev
        await run(journal: journal, repairer: repairer, scope: Guard())
        XCTAssertEqual(repairer.evidence.first??.priorRunLedger.count ?? 0, 0)
    }

    func testSettlementSurvivesACrashReconstruction() {
        let start = LoopRunEvent.Start(id: "r", projectId: nil, trigger: .manual, gitRoot: "/x", startedAt: Date(),
                                       config: LoopRunConfigSnapshot(config), loopId: "primary", loopName: "L")
        let attempt = LoopStageAttempt(stageId: "t", stageName: "T", kind: .shellCommand, severity: .blocking,
                                       startedAt: Date(), durationSeconds: 1, exitCode: 1, passed: false,
                                       outputTail: "", outputHash: "h", score: 1, ledger: entry(1))
        let events = [LoopRunEvent(kind: LoopRunEvent.Kind.started, start: start),
                      LoopRunEvent(kind: LoopRunEvent.Kind.iterationStarted, iteration: 1),
                      LoopRunEvent(kind: LoopRunEvent.Kind.stageFinished, iteration: 1, stageId: "t", attempt: attempt),
                      LoopRunEvent(kind: LoopRunEvent.Kind.ledgerSettled, iteration: 2, stageId: "t", detail: "h2")]
        let rec = LoopRunEvent.reconstruct(from: events)
        XCTAssertEqual(rec?.iterations.first?.attempts.first?.ledger?.resultingFailureSet, "h2")
    }

    // MARK: - Real git: tree-to-tree snapshots

    private func git(_ args: String, in dir: URL) throws -> String {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "cd '\(dir.path)' && git -c user.email=a@b -c user.name=n \(args)"]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
        try p.run(); p.waitUntilExit()
        return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    func testTreeDiffSeesReEditOfDirtyFileAndNewFileButNotThePreDirtyEdit() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ledger-git-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        _ = try git("init -q && echo a > a.txt && echo b > b.txt && printf 'ignored.log\\n' > .gitignore "
                    + "&& git add -A && git commit -q -m init", in: dir)
        try "user edit\n".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        try "user edit b\n".write(to: dir.appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)
        let statusBefore = try git("status --porcelain", in: dir)

        let guardian = GitRepairScopeGuard()
        let beforeOpt = await guardian.snapshotTree(gitRoot: dir)
        let before = try XCTUnwrap(beforeOpt)
        try "agent edit\n".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        try "brand new\n".write(to: dir.appendingPathComponent("new.txt"), atomically: true, encoding: .utf8)
        try "noise\n".write(to: dir.appendingPathComponent("ignored.log"), atomically: true, encoding: .utf8)
        try "SECRET=1\n".write(to: dir.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
        let afterOpt = await guardian.snapshotTree(gitRoot: dir)
        let after = try XCTUnwrap(afterOpt)
        let diffOpt = await guardian.treeDiff(
            from: before, to: after, gitRoot: dir, maxChars: 4_000,
            isQuotable: { !LoopAttemptLedger.isUnquotable($0, protectedGlobs: []) })
        let diff = try XCTUnwrap(diffOpt)

        XCTAssertEqual(Set(diff.changedPaths), ["a.txt", "new.txt", ".env"])
        XCTAssertTrue(diff.diff.contains("agent edit"), "re-edit of an already-dirty file is recorded")
        XCTAssertTrue(diff.diff.contains("brand new"), "a new untracked file appears with content")
        XCTAssertFalse(diff.diff.contains("user edit b"), "the user's untouched pre-dirty edit is not in it")
        XCTAssertFalse(diff.diff.contains("SECRET=1"), "secret contents are never read")
        let statusAfter = try git("status --porcelain", in: dir)
        XCTAssertFalse(statusAfter.contains("A  "), "the real index is untouched (nothing staged)")
        XCTAssertTrue(statusBefore.contains(" M a.txt"))
    }
}

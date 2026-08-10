import XCTest
@testable import LlmIdeMacLib

/// The summary note is the loop's user-facing output. If it omits what changed,
/// or reports a protected-path violation as an ordinary repair, a reader draws
/// the wrong conclusion about a run they did not watch.
final class LoopRunSummaryWriterTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-summary-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    private func makeRecord(status: LoopEngineStatus = .success,
                            attempts: [LoopStageAttempt]? = nil,
                            config: LoopEngineConfig? = nil) -> LoopRunRecord {
        let started = Date(timeIntervalSince1970: 1_760_000_000)
        let resolved = config ?? LoopEngineConfig(
            stages: [
                LoopStage(id: "s1", name: "Apply skill", kind: .skill, order: 0, skillId: "skills/fix"),
                LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1),
                LoopStage(id: "l1", name: "Lint", kind: .shellCommand, command: "make lint",
                          order: 2, severity: .advisory)
            ],
            maxIterations: 8, consecutiveFailureStop: 3,
            wallClockBudgetSeconds: 1800, maxRepairsPerStage: 2)
        let resolvedAttempts = attempts ?? [
            LoopStageAttempt(stageId: "t1", stageName: "Test", kind: .shellCommand,
                             severity: .blocking, startedAt: started, durationSeconds: 12.34,
                             exitCode: 1, passed: false,
                             outputTail: "Executed 10 tests, with 4 failures",
                             outputHash: "hash", score: 4, repairAttempted: true,
                             changedPaths: ["Sources/Thing.swift"], scopeVerdict: .clean)
        ]
        return LoopRunRecord(
            id: "RUN-1", projectId: "proj", trigger: .autoTask, gitRoot: "/repo",
            startedAt: started, endedAt: started.addingTimeInterval(95),
            iterationsUsed: 1, config: LoopRunConfigSnapshot(resolved),
            iterations: [LoopIterationRecord(index: 1, attempts: resolvedAttempts)],
            statusCode: status.code, statusSummary: status.summary)
    }

    private func render(_ record: LoopRunRecord) -> String {
        NoteLoopRunSummaryWriter.render(record, title: "Loop run — \(record.statusSummary)")
    }

    // MARK: - Content

    func testSummaryLeadsWithTheOutcomeTriggerAndRepo() {
        let md = render(makeRecord(status: .givenUp(reason: .maxIterations)))
        XCTAssertTrue(md.contains("given up (max iterations)"))
        XCTAssertTrue(md.contains("autoTask"))
        XCTAssertTrue(md.contains("/repo"))
        XCTAssertTrue(md.contains("95s over 1 iteration(s)"))
    }

    /// Frontmatter carries the machine-readable status code and run id so the note
    /// can be filtered in the Library and matched back to its journal record.
    func testFrontmatterCarriesStatusCodeTriggerAndRunId() {
        let md = render(makeRecord(status: .blocked(
            reason: .repairOutOfScope(stageName: "Test", paths: ["mac/Tests/A.swift"]))))
        XCTAssertTrue(md.hasPrefix("---\n"))
        XCTAssertTrue(md.contains("status: blocked.repair_out_of_scope"))
        XCTAssertTrue(md.contains("trigger: autoTask"))
        XCTAssertTrue(md.contains("runId: RUN-1"))
        XCTAssertTrue(md.contains("noteType: loop"))
    }

    /// The pipeline section is what tells a reader what the loop was *for* —
    /// including which stages generate versus gate.
    func testPipelineLabelsGenerateVerifyAndAdvisory() {
        let md = render(makeRecord())
        XCTAssertTrue(md.contains("**Apply skill** (generate)"))
        XCTAssertTrue(md.contains("**Test** (verify)"))
        XCTAssertTrue(md.contains("**Lint** (verify, advisory)"))
        XCTAssertTrue(md.contains("skills/fix"))
    }

    func testBudgetsAreRecordedFromTheRunsOwnConfigSnapshot() {
        let md = render(makeRecord())
        XCTAssertTrue(md.contains("8 iterations"))
        XCTAssertTrue(md.contains("stop after 3 non-improving"))
        XCTAssertTrue(md.contains("30 min"))
        XCTAssertTrue(md.contains("2 repairs/stage"))
        XCTAssertTrue(md.contains("protected paths: revert"))
    }

    func testUnlimitedTimeBudgetIsSpelledOut() {
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], wallClockBudgetSeconds: nil)
        XCTAssertTrue(render(makeRecord(config: config)).contains("no time limit"))
    }

    func testPerStageTableCarriesResultScoreAndDuration() {
        let md = render(makeRecord())
        XCTAssertTrue(md.contains("### Iteration 1"))
        XCTAssertTrue(md.contains("| Test | FAIL (exit 1) | 4 | 12.3s | yes · clean |"))
    }

    /// "What did this run change" is the first question a reader has.
    func testFilesChangedSectionListsAttributedPaths() {
        let md = render(makeRecord())
        XCTAssertTrue(md.contains("## Files changed"))
        XCTAssertTrue(md.contains("`Sources/Thing.swift`"))
    }

    func testFilesChangedSectionIsOmittedWhenNothingChanged() {
        let attempt = LoopStageAttempt(
            stageId: "t1", stageName: "Test", kind: .shellCommand, severity: .blocking,
            startedAt: Date(timeIntervalSince1970: 1_760_000_000), durationSeconds: 1,
            exitCode: 0, passed: true, outputTail: "", outputHash: nil, score: 0)
        XCTAssertFalse(render(makeRecord(attempts: [attempt])).contains("## Files changed"))
    }

    /// A violation must be called out as such, not folded into "a repair ran" —
    /// the whole point is that the stage was NOT legitimately fixed.
    func testProtectedPathViolationsGetTheirOwnSection() {
        let attempt = LoopStageAttempt(
            stageId: "t1", stageName: "Test", kind: .shellCommand, severity: .blocking,
            startedAt: Date(timeIntervalSince1970: 1_760_000_000), durationSeconds: 2,
            exitCode: 1, passed: false, outputTail: "boom", outputHash: "h", score: 3,
            repairAttempted: true, changedPaths: ["mac/Tests/A.swift"],
            scopeVerdict: .violatedReverted)
        let md = render(makeRecord(attempts: [attempt]))
        XCTAssertTrue(md.contains("## Protected-path violations"))
        XCTAssertTrue(md.contains("violatedReverted"))
        XCTAssertTrue(md.contains("blocked, not fixed"))
    }

    func testNoViolationSectionOnACleanRun() {
        XCTAssertFalse(render(makeRecord()).contains("## Protected-path violations"))
    }

    /// A run rejected at preflight journals with no iterations; the note must say
    /// so rather than render an empty table.
    func testRunWithNoIterationsSaysSoExplicitly() {
        var record = makeRecord(status: .needsApproval(stageName: "Test"))
        record.iterations = []
        let md = render(record)
        XCTAssertTrue(md.contains("ended before any stage executed"))
        XCTAssertFalse(md.contains("### Iteration"))
    }

    func testJournalPointerIsIncluded() {
        let md = render(makeRecord())
        XCTAssertTrue(md.contains("system/loop-runs/"))
        XCTAssertTrue(md.contains("RUN-1"))
    }

    // MARK: - Writing

    func testWriteLandsUnderLlmDocLoopWithAMonthFolder() async {
        let result = await NoteLoopRunSummaryWriter().write(makeRecord(), root: root)
        guard case .written(let path) = result else {
            return XCTFail("expected a written note, got \(result)")
        }
        XCTAssertTrue(path.contains("llm-doc/loop/"), "unexpected path: \(path)")
        XCTAssertTrue(path.hasSuffix(".md"))
        // 2025-10 — the fixed 1_760_000_000 epoch used by makeRecord.
        XCTAssertTrue(path.contains("/2025/10/"), "expected a yyyy/MM folder, got: \(path)")
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: root.appendingPathComponent(path).path))
    }

    /// Fail-open, like the journal: a note that cannot be written reports a reason
    /// rather than throwing into the run's verdict.
    func testWriteToAnUnwritableRootReportsAFailure() async {
        let result = await NoteLoopRunSummaryWriter()
            .write(makeRecord(), root: URL(fileURLWithPath: "/dev/null/nope"))
        guard case .failed = result else {
            return XCTFail("expected .failed, got \(result)")
        }
    }
}

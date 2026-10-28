import Foundation
import LlmIdeMacLib

// The pure half of the runner's Mikado rollback (design doc §3.5, §5):
// where a batch starts (its base, and the "passed after repair" restart
// target), which paths a rollback restores, and the words it records. The
// runner's state machine itself is covered by XCTest (LoopEngineRunnerTests).

#if FEATURE_AUTOTASK
func runRefactorBatchRollbackChecks() {
    print("refactor batch rollback (runner)")

    // MARK: - Where a batch starts (§5.5, §5.7)

    let writer = LoopStage(name: "Refactor Test Write", kind: .skill, order: 0,
                           skillId: "skills/test-gap-writer",
                           targetPath: "llm-doc/loop/refactor/NEXT-BATCH.md", outputPath: ".")
    let mapWriter = LoopStage(name: "Test Write", kind: .skill, order: 0,
                              skillId: "skills/test-gap-writer", targetPath: "llm-doc/loop/test/TEST-MAP.md")
    expect(writer.isRefactorTestWrite, "the test writer pointed at NEXT-BATCH.md is the refactor test writer")
    expect(!mapWriter.isRefactorTestWrite, "the Test loop's writer (Input: a test map) is not")

    let fm = FileManager.default
    let root = makeTempDir()
    defer { try? fm.removeItem(at: root) }
    try? "test:\n\trun-tests\n".write(to: root.appendingPathComponent("Makefile"), atomically: true, encoding: .utf8)
    let stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: root)
        .filter(\.enabled)
    let start = RefactorBatchRollback.firstBatchStageIndex(in: stages)
    expect(start.flatMap { stages[$0].defaultKey } == "refactor-test-write",
           "the default refactor loop's batch starts at Refactor Test Write")
    let planIndex = stages.firstIndex { $0.defaultKey == "refactor-plan" }
    expect(planIndex != nil && start != nil && planIndex! < start!,
           "the planner sits before the batch start, so a batch restart never re-runs it")
    let noWriter = stages.filter { $0.defaultKey != "refactor-test-write" }
    expect(RefactorBatchRollback.firstBatchStageIndex(in: noWriter).flatMap { noWriter[$0].defaultKey }
           == "refactor-apply", "without the test writer the batch starts at Refactor Apply")
    let bare = makeTempDir()
    defer { try? fm.removeItem(at: bare) }
    let planOnly = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: bare)
    expect(RefactorBatchRollback.firstBatchStageIndex(in: planOnly) == nil,
           "a plan-only refactor loop (no test command) has no batch stage")

    // MARK: - Baselines on a mid-batch restart (§5.7)

    // The default loop with a check command too: Test Write → Test Baseline →
    // Check Baseline → Apply → Conform → Check → Test → Ledger → Graph Check.
    let checked = makeTempDir()
    defer { try? fm.removeItem(at: checked) }
    try? "test:\n\trun-tests\nlint:\n\trun-lint\n".write(to: checked.appendingPathComponent("Makefile"),
                                                         atomically: true, encoding: .utf8)
    let full = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: checked)
        .filter(\.enabled)
    func stage(_ key: String) -> LoopStage? { full.first { $0.defaultKey == key } }
    if let testBase = stage("refactor-test-baseline"), let checkBase = stage("refactor-check-baseline"),
       let apply = stage("refactor-apply"), let check = stage("refactor-check"), let test = stage("refactor-test") {
        let applied: Set<String> = [apply.id]
        expect(RefactorBatchRollback.skipsBaselineOnRestart(testBase, in: full, appliedStageIDs: applied)
               && RefactorBatchRollback.skipsBaselineOnRestart(checkBase, in: full, appliedStageIDs: applied),
               "once Apply applied the batch, a restart skips Test Baseline and Check Baseline")
        expect(!RefactorBatchRollback.skipsBaselineOnRestart(testBase, in: full, appliedStageIDs: [])
               && !RefactorBatchRollback.skipsBaselineOnRestart(checkBase, in: full, appliedStageIDs: []),
               "before Apply has applied (the batch's first pass), the baselines run")
        expect(!RefactorBatchRollback.skipsBaselineOnRestart(check, in: full, appliedStageIDs: applied)
               && !RefactorBatchRollback.skipsBaselineOnRestart(test, in: full, appliedStageIDs: applied),
               "the repairable Check and Test after Apply always run")
        var lateBaseline = checkBase
        lateBaseline.id = "late"
        let reordered = full + [lateBaseline]
        expect(!RefactorBatchRollback.skipsBaselineOnRestart(lateBaseline, in: reordered, appliedStageIDs: applied),
               "a non-repairable stage AFTER Apply is never skipped")
    } else {
        expect(false, "the default refactor loop with a check command has both baselines, Apply, Check and Test")
    }

    // MARK: - Blocked or back to todo (I3)

    let shellBaseline = LoopStage(name: "Check Baseline", kind: .shellCommand, command: "make lint", order: 0,
                                  allowsRepair: false)
    let shellTest = LoopStage(name: "Test", kind: .shellCommand, command: "make test", order: 1)
    let graphCheck = LoopStage(name: "Graph Check", kind: .codeGraph, order: 2, graphOp: .verify)
    let applyStage = LoopStage(name: "Refactor Apply", kind: .skill, order: 3, skillId: "skills/refactor-apply")
    typealias Outcome = RefactorBatchRollback.PlanOutcome
    func outcome(_ error: Bool, _ stage: LoopStage?, violation: Bool = false, restored: Bool = true) -> Outcome {
        RefactorBatchRollback.planOutcome(endedWithError: error, terminatingStage: stage,
                                          contentViolation: violation, treeRestored: restored)
    }
    expect(outcome(true, shellBaseline) == .todo, "a red non-repairable baseline puts the batch back to todo")
    expect(outcome(true, applyStage) == .todo, "an agent/transport error in the batch puts it back to todo")
    expect(outcome(true, shellTest) == .todo, "a command that could not run (plain .error) puts it back to todo")
    expect(outcome(true, graphCheck) == .blocked, "a Graph Check failure keeps the batch blocked")
    expect(outcome(false, shellTest) == .blocked, "a give-up (or a scope block) keeps the batch blocked")
    expect(outcome(true, applyStage, violation: true) == .blocked,
           "a write-scope violation reported as .error keeps the batch blocked")
    expect(outcome(true, shellBaseline, restored: false) == .blocked,
           "a batch whose tree was not restored is always blocked, never retried on top of itself")

    // MARK: - Restore list (§5.2)

    let changed: Set<String> = [
        "Sources/B.swift", "Sources/A.swift", "Tests/ATests.swift",
        "llm-doc/loop/refactor/REFACTOR.md", "llm-doc/loop/refactor/RULES.md",
        "system/loop/refactor/graph/after.json", "llm-doc/loop/refactor",
        "llm-doc/loop/refactor-notes.md", "docs/PLAN.md",
    ]
    let restored = RefactorBatchRollback.restorePaths(changed, planPath: "docs/PLAN.md")
    expect(restored == ["Sources/A.swift", "Sources/B.swift", "Tests/ATests.swift",
                        "llm-doc/loop/refactor-notes.md"],
           "restore = the batch's changed paths minus the refactor llm-doc dir, the refactor machine data (system/loop/refactor) and the plan, sorted")
    expect(RefactorBatchRollback.restorePaths([], planPath: nil).isEmpty, "nothing changed → nothing restored")

    // MARK: - Recorded words (§3.5)

    expect(RefactorBatchRollback.blockedReason(
               stageName: "Test", summary: "given up (repair budget exhausted for \"Test\")\nmore detail")
           == "Test — given up (repair budget exhausted for \"Test\")",
           "the Blocked: reason is `<stage> — <first line of why the run ended>`")
    expect(RefactorBatchRollback.rolledBackMessage(batchId: "R3")
           == "R3 rolled back; tree restored to before the batch",
           "the rollback log line names the batch")
}
#endif

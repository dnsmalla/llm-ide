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

    // MARK: - Restore list (§5.2)

    let changed: Set<String> = [
        "Sources/B.swift", "Sources/A.swift", "Tests/ATests.swift",
        "llm-doc/loop/refactor/REFACTOR.md", "llm-doc/loop/refactor/RULES.md",
        "llm-doc/loop/refactor/graph/after.json", "llm-doc/loop/refactor",
        "llm-doc/loop/refactor-notes.md", "docs/PLAN.md",
    ]
    let restored = RefactorBatchRollback.restorePaths(changed, planPath: "docs/PLAN.md")
    expect(restored == ["Sources/A.swift", "Sources/B.swift", "Tests/ATests.swift",
                        "llm-doc/loop/refactor-notes.md"],
           "restore = the batch's changed paths minus the refactor llm-doc dir and the plan, sorted")
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

import Foundation
import LlmIdeMacLib

// Several refactor batches per run (design doc §3.6, §5.3, §5.4): the config
// knob and its clamp, which batch the runner starts next, the run's batch
// summary, and when a later batch's rollback still leaves the run a success.
// The runner's state machine itself is covered by XCTest (LoopEngineRunnerTests).

#if FEATURE_AUTOTASK
func runRefactorMultiBatchChecks() {
    print("refactor: several batches per run")

    // MARK: - Config (nil = 3, clamped 1…10, round-trips)

    let decoder = JSONDecoder()
    func decoded(_ json: String) -> LoopEngineConfig? {
        try? decoder.decode(LoopEngineConfig.self, from: Data(json.utf8))
    }
    let absent = decoded(#"{"stages":[]}"#)
    expect(absent != nil && absent?.refactorBatchesPerRun == nil,
           "a config saved before batchesPerRun existed decodes, with no value")
    expect(absent?.effectiveRefactorBatchesPerRun == 3, "no value means 3 batches per run")
    expect(decoded(#"{"stages":[],"refactorBatchesPerRun":null}"#)?.effectiveRefactorBatchesPerRun == 3,
           "an explicit null also means 3")
    expect(decoded(#"{"stages":[],"refactorBatchesPerRun":0}"#)?.effectiveRefactorBatchesPerRun == 1,
           "0 is clamped up to 1")
    expect(decoded(#"{"stages":[],"refactorBatchesPerRun":99}"#)?.effectiveRefactorBatchesPerRun == 10,
           "99 is clamped down to 10")
    expect(decoded(#"{"stages":[],"refactorBatchesPerRun":5}"#)?.effectiveRefactorBatchesPerRun == 5,
           "5 is kept")
    var five = LoopEngineConfig(stages: [])
    five.refactorBatchesPerRun = 7
    let roundTrip = (try? JSONEncoder().encode(five)).flatMap { try? decoder.decode(LoopEngineConfig.self, from: $0) }
    expect(roundTrip?.refactorBatchesPerRun == 7, "encode then decode keeps the value")
    let unsetRoundTrip = (try? JSONEncoder().encode(LoopEngineConfig(stages: [])))
        .flatMap { try? decoder.decode(LoopEngineConfig.self, from: $0) }
    expect(unsetRoundTrip != nil && unsetRoundTrip?.refactorBatchesPerRun == nil,
           "an unset value stays unset through a save")

    // MARK: - Which batch starts next (§3.6)

    let plan = """
    ### R1 Split  (status: done)
    - Files: `a.swift`

    ### R2 Move  (status: blocked)
    - Blocked: Test — given up

    ### R3 Rename  (status: todo)
    - Files: `c.swift`

    ### R4 Tidy  (status: todo)
    - Files: `d.swift`
    """
    expect(RefactorBatchSequence.nextBatch(plan: plan, processed: ["R1"], limit: 3) == "R3",
           "the next batch is the plan's first todo one (a blocked batch is not todo)")
    expect(RefactorBatchSequence.nextBatch(plan: plan, processed: ["R1", "R3"], limit: 2) == nil,
           "no further batch once the run's limit is reached")
    expect(RefactorBatchSequence.nextBatch(plan: plan, processed: ["R1"], limit: 1) == nil,
           "a limit of 1 is today's one batch per run")
    expect(RefactorBatchSequence.nextBatch(plan: "### R1 Split  (status: done)\n", processed: ["R1"], limit: 3) == nil,
           "no further batch when no todo batch remains")
    expect(RefactorBatchSequence.nextBatch(plan: plan, processed: ["R3"], limit: 3) == nil,
           "a batch already processed this run is never started again (apply left it todo)")
    expect(RefactorBatchSequence.nextBatch(plan: nil, processed: ["R1"], limit: 3) == nil,
           "no further batch when the plan cannot be read")

    // MARK: - Run summary (§3.6, §5.3)

    let rolledBack = RefactorBatchSequence.rolledBackEntry(
        batchId: "R3", reason: "Test — given up (repeated failure)", treeRestored: true, problem: nil)
    expect(rolledBack == "Rolled back: R3 (blocked: Test — given up (repeated failure))",
           "a restored batch reads `Rolled back: R<n> (blocked: …)`")
    expect(RefactorBatchSequence.batchesSummary(applied: ["R1", "R2"], skipped: [], rolledBack: rolledBack)
           == "Applied: R1, R2 · Rolled back: R3 (blocked: Test — given up (repeated failure))",
           "the summary lists every batch applied and rolled back this run")
    expect(RefactorBatchSequence.batchesSummary(applied: ["R1"], skipped: ["R2"], rolledBack: nil)
           == "Applied: R1 · Skipped: R2", "a skipped batch is listed as skipped")
    expect(RefactorBatchSequence.batchesSummary(applied: [], skipped: [], rolledBack: rolledBack) == nil,
           "with no batch kept the rollback's own line stands alone (nil here)")
    expect(RefactorBatchSequence.rolledBackEntry(batchId: "R3", reason: "Check Baseline — error: red", treeRestored: true,
                                                 problem: nil, backToTodo: true)
           == "Rolled back: R3 (back to todo: Check Baseline — error: red)",
           "a batch put back to todo says so instead of `blocked`")
    expect(RefactorBatchSequence.rolledBackEntry(batchId: "R3", reason: "x", treeRestored: false,
                                                 problem: "no base", backToTodo: true).contains("blocked: x"),
           "a batch whose tree was not restored always reads blocked")
    let notRestored = RefactorBatchSequence.rolledBackEntry(
        batchId: "R3", reason: "Test — x", treeRestored: false, problem: "no base")
    expect(notRestored.hasPrefix("Not rolled back: R3") && notRestored.contains("no base"),
           "a batch whose tree could not be restored says so")

    // MARK: - Verdict with partial success (§5.3)

    expect(RefactorBatchSequence.keepsVerifiedBatches(verifiedCount: 2, endingRollsBack: true, failedBatchCleared: true),
           "≥1 verified batch and the failed one rolled back → the run succeeds")
    expect(!RefactorBatchSequence.keepsVerifiedBatches(verifiedCount: 0, endingRollsBack: true, failedBatchCleared: true),
           "zero verified + a rollback → the run fails")
    expect(!RefactorBatchSequence.keepsVerifiedBatches(verifiedCount: 1, endingRollsBack: false, failedBatchCleared: true),
           "a Stop or an approval wait keeps its own verdict (the tree holds a half batch)")
    expect(!RefactorBatchSequence.keepsVerifiedBatches(verifiedCount: 1, endingRollsBack: true, failedBatchCleared: false),
           "a failed batch still in the tree is never shipped as a success")
}
#endif

import Foundation

/// The pure half of the Refactoring loop's Mikado rollback (design doc §3.5,
/// §5): which stage starts a batch, which paths a rollback restores, and the
/// words it records. The runner (`LoopEngineRunner+CodeGraph.swift`) owns the
/// state and the side effects; everything here is a function of its inputs,
/// so `loop-contract-lab` asserts it directly.
public enum RefactorBatchRollback {

    /// The run-order index of a batch's first stage: the refactor test writer,
    /// or the apply stage when the writer is not in the run. The batch base is
    /// taken there (§5.5), and once a batch has started a "passed after
    /// repair" restart re-enters there instead of at stage 0 (§5.7) — the
    /// planner must never re-plan underneath a batch that is half applied.
    public static func firstBatchStageIndex(in stages: [LoopStage]) -> Int? {
        stages.firstIndex { $0.isRefactorTestWrite || $0.isRefactorApply }
    }

    /// Whether `stage` is skipped (as already passed) when a "passed after
    /// repair" restart re-enters a batch whose apply stage already applied it.
    ///
    /// True for a non-repairable shell stage (`allowsRepair == false`: Test
    /// Baseline, Check Baseline) that sits inside the batch BEFORE the apply
    /// stage, once that apply stage is in `appliedStageIDs`. Such a stage
    /// measures the tree as it was before the batch, and it already passed
    /// there on the batch's first pass (else the run would have ended). Re-run
    /// mid-batch it measures the half-applied tree instead — red tests after a
    /// Check repair, say — and, unable to repair, would end the run before the
    /// stage that CAN repair that failure ever got its turn. `stages` is the
    /// run order.
    public static func skipsBaselineOnRestart(_ stage: LoopStage, in stages: [LoopStage],
                                              appliedStageIDs: Set<String>) -> Bool {
        guard stage.kind == .shellCommand, !stage.allowsRepair,
              let start = firstBatchStageIndex(in: stages),
              let applyIndex = stages.firstIndex(where: { $0.isRefactorApply }),
              appliedStageIDs.contains(stages[applyIndex].id),
              let index = stages.firstIndex(where: { $0.id == stage.id }) else { return false }
        return index >= start && index < applyIndex
    }

    /// What a rolled-back batch becomes in the plan.
    public enum PlanOutcome: String, Equatable {
        /// The batch's own content is implicated: `(status: blocked)` with a
        /// `- Blocked:` line, and the planner works around it (`- Replaces:`).
        case blocked
        /// The run ended for a reason that says nothing about the batch: back to
        /// `(status: todo)`, retried as-is by the next run.
        case todo
    }

    /// Whether a rolled-back batch is `blocked` or goes back to `todo`.
    ///
    /// `todo` only when the run ended with a plain `.error` (`endedWithError`)
    /// that does not implicate the batch: a non-repairable baseline stage that
    /// failed (it measured the tree before Apply), an agent or transport call
    /// that failed, a command that could not launch. Everything else stays
    /// `blocked` — a give-up (the batch could not be made green), a scope
    /// violation (`contentViolation`, or a `.blocked` ending), and a Graph
    /// Check failure (the batch moved the structure the wrong way). Marking an
    /// infrastructure failure `blocked` would have the planner write
    /// `- Replaces:` batches around a "blocker" that was never in the batch.
    /// `treeRestored == false` is always `blocked`: the batch's edits are still
    /// in the tree, and retrying it as-is would apply it on top of itself.
    public static func planOutcome(endedWithError: Bool, terminatingStage: LoopStage?,
                                   contentViolation: Bool, treeRestored: Bool) -> PlanOutcome {
        guard treeRestored, endedWithError, !contentViolation,
              terminatingStage?.kind != .codeGraph else { return .blocked }
        return .todo
    }

    /// The paths a rollback restores from the batch base: the union of what the
    /// batch's own stages changed (§5.2), minus the refactor llm-doc directory,
    /// the refactor machine data under `system/loop/refactor/` (D6: the graph
    /// snapshots moved there from llm-doc), and the plan file. Those hold the
    /// loop's record of the batch — the plan the rollback is about to mark
    /// blocked, RULES.md, the graph snapshots — and restoring them would erase
    /// the very note that says what happened. Sorted, so the restore (and its
    /// log line) is deterministic.
    public static func restorePaths(_ changed: Set<String>, planPath: String?) -> [String] {
        let docDir = LoopOutputLayout.refactorDir
        let dataDir = LoopOutputLayout.dataRoot + "/refactor"
        return changed.filter { path in
            path != docDir && !path.hasPrefix(docDir + "/")
                && path != dataDir && !path.hasPrefix(dataDir + "/")
                && path != planPath
        }.sorted()
    }

    /// The `- Blocked:` reason written under the batch header:
    /// `<stage> — <first line of why the run ended>`.
    public static func blockedReason(stageName: String, summary: String) -> String {
        let firstLine = summary.split(whereSeparator: \.isNewline).first.map(String.init) ?? summary
        return "\(stageName) — \(firstLine.trimmingCharacters(in: .whitespaces))"
    }

    /// The run-log line for a batch whose tree was put back.
    public static func rolledBackMessage(batchId: String) -> String {
        "\(batchId) rolled back; tree restored to before the batch"
    }
}

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

    /// The paths a rollback restores from the batch base: the union of what the
    /// batch's own stages changed (§5.2), minus the refactor llm-doc directory
    /// and the plan file. Those hold the loop's record of the batch — the plan
    /// the rollback is about to mark blocked, RULES.md, the graph snapshots —
    /// and restoring them would erase the very note that says what happened.
    /// Sorted, so the restore (and its log line) is deterministic.
    public static func restorePaths(_ changed: Set<String>, planPath: String?) -> [String] {
        let docDir = LoopOutputLayout.refactorDir
        return changed.filter { path in
            path != docDir && !path.hasPrefix(docDir + "/") && path != planPath
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

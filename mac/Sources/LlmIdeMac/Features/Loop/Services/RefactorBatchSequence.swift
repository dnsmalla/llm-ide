import Foundation

/// The pure half of running several refactor batches in one run (design doc
/// §3.6, §5.3, §5.4): which batch starts next, how the run's batches are
/// summarised, and when a later batch's failure still leaves the run a
/// success. The runner (`LoopEngineRunner+RefactorBatches.swift`) owns the
/// state and the side effects; everything here is a function of its inputs, so
/// `loop-contract-lab` asserts it directly.
public enum RefactorBatchSequence {

    /// The batch the run starts after one passed every check, or nil when the
    /// run ends here: `processed` (the batches this run already applied or
    /// skipped, in order) has reached `limit`, the plan has no `todo` batch
    /// left (`blocked`, `done` and `skipped` are not todo), the plan could not
    /// be read, or its first todo batch was already processed this run — the
    /// apply stage left it `todo`, and starting it again would stack the same
    /// batch onto itself.
    public static func nextBatch(plan: String?, processed: [String], limit: Int) -> String? {
        guard processed.count < limit, let plan,
              let next = RefactorPlanDiff.firstTodo(in: plan)?.id,
              !processed.contains(next) else { return nil }
        return next
    }

    /// One batch the run rolled back, as the batch summary lists it. A batch
    /// put back to `todo` (`backToTodo`) says so instead of `blocked`; one whose
    /// tree could not be restored is always blocked.
    public static func rolledBackEntry(batchId: String, reason: String, treeRestored: Bool,
                                       problem: String?, backToTodo: Bool = false,
                                       restoredCount: Int = 0, leftAlone: [String] = []) -> String {
        if !treeRestored, !leftAlone.isEmpty {
            return "Partly rolled back: \(batchId) (\(restoredCount) restored, \(leftAlone.count) left as found: "
                + "\(leftAlone.joined(separator: ", ")); blocked: \(reason))" + (problem.map { " — \($0)" } ?? "")
        }
        guard treeRestored else {
            return "Not rolled back: \(batchId) — tree left as the batch made it "
                + "(\(problem ?? "unknown")); blocked: \(reason)"
        }
        let label = backToTodo ? "back to todo" : "blocked"
        return "Rolled back: \(batchId) (\(label): \(reason))" + (problem.map { " — \($0)" } ?? "")
    }

    /// `Applied: R1, R2 · Skipped: R4 · Rolled back: R3 (blocked: …)` for the
    /// summary note and the finish notification. Nil when the run kept no batch
    /// (none applied or skipped): a lone rollback then gets its own line
    /// (`LoopBatchRollback.summary`) — and ONLY then, since this list already
    /// names it — and a run that touched no batch has none.
    public static func batchesSummary(applied: [String], skipped: [String], rolledBack: String?) -> String? {
        guard !applied.isEmpty || !skipped.isEmpty else { return nil }
        var parts: [String] = []
        if !applied.isEmpty { parts.append("Applied: " + applied.joined(separator: ", ")) }
        if !skipped.isEmpty { parts.append("Skipped: " + skipped.joined(separator: ", ")) }
        if let rolledBack { parts.append(rolledBack) }
        return parts.joined(separator: " · ")
    }

    /// Whether a run whose LAST batch failed still succeeds (§5.3): at least one
    /// batch was verified this run, the ending is one that rolls a batch back
    /// (`LoopEngineRunner.rollsBackBatch` — never a Stop or an approval wait,
    /// which leave a half batch in the tree for the user to look at), and the
    /// failed batch is out of the tree. Then the tree holds exactly the verified
    /// batches, so the run can ship them; a failed batch still in the tree must
    /// never be shipped as a success.
    public static func keepsVerifiedBatches(verifiedCount: Int, endingRollsBack: Bool,
                                            failedBatchCleared: Bool) -> Bool {
        verifiedCount > 0 && endingRollsBack && failedBatchCleared
    }
}

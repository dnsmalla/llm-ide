import Foundation

// Several refactor batches per run (design doc §3.6, §5.3, §5.4), kept out of
// LoopEngineRunner.swift. The pure rules are `RefactorBatchSequence`; the state
// (`appliedBatchIds`, `skippedBatchIds`, `lastVerifiedGraph`) lives on the
// runner, and `startNextBatch` (main file) does the reset, because the state it
// clears is private there.
extension LoopEngineRunner {

    /// Called when the pipeline passed end to end. Records the batch Apply
    /// recorded as verified (or skipped), then returns the next `todo` batch to
    /// start, or nil when the run ends here: no batch was recorded (not a
    /// refactor run, or Apply applied nothing), the run's limit is reached, a
    /// Stop is pending (the verified batch ends the run as a success, as it
    /// always did, instead of the next batch turning it into an abort), a
    /// stage's agent call errored (another batch would only spend more on a
    /// backend that is failing), the time budget is used up, or
    /// `RefactorBatchSequence.nextBatch` finds no batch to start.
    func finishVerifiedBatch(config: LoopEngineConfig, budgetLeft: Bool) -> String? {
        guard let finished = currentBatchId else { return nil }
        if currentBatchSkipped {
            skippedBatchIds.append(finished)
        } else {
            appliedBatchIds.append(finished)
        }
        let limit = config.effectiveRefactorBatchesPerRun
        let processed = appliedBatchIds + skippedBatchIds
        guard processed.count < limit else {
            if limit > 1 { appendLog(.info, "Batch limit reached (\(limit) per run)") }
            return nil
        }
        if Task.isCancelled { return nil }
        if stageStates.values.contains(.errored) {
            appendLog(.warn, "Not starting another batch: a stage's agent call errored this batch")
            return nil
        }
        guard budgetLeft else {
            appendLog(.info, "Not starting another batch: the run's time budget is used up")
            return nil
        }
        let plan = currentRunContext
            .flatMap { refactorPlanURL(gitRoot: $0.gitRoot, faultsRoot: $0.faultsRoot) }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        return RefactorBatchSequence.nextBatch(plan: plan, processed: processed, limit: limit)
    }

    /// The run's final verdict once a LATER batch failed (§5.3): with at least
    /// one batch verified this run and the failed one rolled back out of the
    /// tree, the run succeeds, so the verified batches can ship. The failed
    /// batch is still listed (`batchesSummary`) and stays `blocked` in the
    /// plan, and a blocked batch has already ended the run — no further batch
    /// is attempted. Any other case keeps `verdict`.
    ///
    /// An errored stage in a verified batch never reaches here as an error:
    /// the run does not move past a batch with an errored stage
    /// (`finishVerifiedBatch`), so an honest-verdict downgrade at this point
    /// came from the batch that was just taken back out.
    func keepingVerifiedBatches(_ verdict: LoopEngineStatus,
                                pipelineStatus: LoopEngineStatus) -> LoopEngineStatus {
        let endingRollsBack = Self.rollsBackBatch(pipelineStatus)
        // Cleared = the failed batch's edits are out of the tree: it was rolled
        // back, or it never started (the run ended before its first stage).
        let cleared = batchRollback?.treeRestored ?? !batchStarted
        guard verdict != .success,
              RefactorBatchSequence.keepsVerifiedBatches(
                verifiedCount: appliedBatchIds.count, endingRollsBack: endingRollsBack,
                failedBatchCleared: cleared) else { return verdict }
        appendLog(.info, "Keeping the \(appliedBatchIds.count) verified batch(es) "
                  + "(\(appliedBatchIds.joined(separator: ", "))); the failed one was rolled back: "
                  + verdict.summary)
        return .success
    }

    /// `Applied: R1, R2 · Rolled back: R3 (blocked: …)` when the run kept a
    /// batch, else the lone rollback's own line, else nil — for the finish
    /// notification.
    var batchesSummary: String? {
        RefactorBatchSequence.batchesSummary(applied: appliedBatchIds, skipped: skippedBatchIds,
                                             rolledBack: batchRollback?.listEntry)
            ?? batchRollback?.summary
    }
}

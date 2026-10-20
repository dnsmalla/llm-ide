import Foundation

// The Refactoring loop's `.codeGraph` stage and its batch capture, kept out of
// LoopEngineRunner.swift, with the batch's Mikado rollback. Run state
// (`graphBefore`, `currentBatchId`, `currentExpect`, `currentBatchSkipped`,
// `refactorPlanBefore`, `batchBaseTree`, `batchChangedPaths`, …) lives on the
// runner; extensions cannot hold stored properties. Features/Loop does not
// import the code-graph module: the graph arrives through `GraphRescanning`.
extension LoopEngineRunner {

    // MARK: - Stage

    /// Rescans, loads and probes the RUN root (where the apply edits, and where a
    /// worktree's graph lives). The before/after/GRAPH files are written to the
    /// MAIN checkout, where the Loop's outputs live.
    func runCodeGraphStage(_ stage: LoopStage, gitRoot: URL) async -> StageDecision {
        let startedAt = Date()
        let mainRoot = currentRunContext?.mainGitRoot ?? gitRoot
        switch stage.graphOp {
        case .snapshot:
            return await runGraphSnapshot(stage, startedAt: startedAt, runRoot: gitRoot, mainRoot: mainRoot)
        case .verify:
            return await runGraphVerify(stage, startedAt: startedAt, runRoot: gitRoot, mainRoot: mainRoot)
        case nil:
            stageStates[stage.id] = .failed
            return .terminate(.error("Stage \"\(stage.name)\" has no operation chosen"))
        }
    }

    private func runGraphSnapshot(_ stage: LoopStage, startedAt: Date, runRoot: URL, mainRoot: URL) async -> StageDecision {
        // Every iteration re-runs this stage, and the apply stage is skipped once
        // it has applied. The baseline is the graph BEFORE any batch, so a later
        // pass must not replace it with a post-apply graph.
        if graphBefore != nil {
            appendLog(.info, "  [\(stage.name)] snapshot already taken this run")
            return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: "")
        }
        // Written first so RULES.md exists even when the graph is unavailable.
        writeRulesDigest(stage, runRoot: runRoot, mainRoot: mainRoot)
        let load = await loadCodeGraph(stage, runRoot: runRoot)
        guard let loaded = load.graph else {
            if graphRescanner == nil {
                appendLog(.info, "  [\(stage.name)] code graph not available in this build; snapshot skipped")
                return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: "")
            }
            return finishCodeGraph(stage, startedAt: startedAt, passed: false,
                                   output: "no graph.json after rescan")
        }
        if let reason = load.notRegenerated {
            appendLog(.warn, "  [\(stage.name)] using the existing graph.json (\(reason))")
        }
        let report = await Self.graphReport(loaded.index, runRoot: runRoot)
        do {
            try Self.writeGraphFile(loaded.data, to: LoopOutputLayout.refactorGraphBefore, root: mainRoot)
            try Self.writeGraphFile(Data(report.render().utf8), to: LoopOutputLayout.refactorGraphMD, root: mainRoot)
        } catch {
            return finishCodeGraph(stage, startedAt: startedAt, passed: false,
                                   output: "could not write the graph snapshot: \(error.localizedDescription)")
        }
        graphBefore = report
        appendLog(.info, "  [\(stage.name)] snapshot · \(report.files) file(s), "
                  + "\(Int(report.counters["cycleCount"] ?? 0)) cycle(s), "
                  + "\(Int(report.counters["filesOver500Count"] ?? 0)) over 500 lines")
        return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: "")
    }

    /// Writes `RULES.md` beside GRAPH.md. A failure only warns: the rules digest
    /// helps the agent but must never stop the graph snapshot.
    private func writeRulesDigest(_ stage: LoopStage, runRoot: URL, mainRoot: URL) {
        let planStage = runOrderedStages.first { $0.defaultKey == "refactor-plan" }
        let checkStage = runOrderedStages.first { $0.defaultKey == "refactor-check" }
        let testStage = runOrderedStages.first { $0.defaultKey == "refactor-test" }
        let digest = RefactorRulesCollector.digest(
            gitRoot: runRoot, inputPath: planStage?.targetPath ?? ".",
            checkCommand: checkStage?.command, testCommand: testStage?.command)
        do {
            try Self.writeGraphFile(Data(digest.utf8), to: LoopOutputLayout.refactorRules, root: mainRoot)
        } catch {
            appendLog(.warn, "  [\(stage.name)] could not write RULES.md: \(error.localizedDescription)")
        }
    }

    /// The start of a verify attempt's output when this build has no code graph.
    /// The run summary matches on it, so keep the two in step.
    static let codeGraphUnverifiedPrefix = "code graph not available in this build; batch"

    private func runGraphVerify(_ stage: LoopStage, startedAt: Date, runRoot: URL, mainRoot: URL) async -> StageDecision {
        if currentBatchSkipped {
            let id = currentBatchId ?? "unknown"
            let message = "batch \(id) was skipped; nothing to verify"
            appendLog(.info, "  [\(stage.name)] \(message)")
            return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: message)
        }
        let batch = currentBatchId ?? "unknown"
        // No rescanner means no code graph in this build. A graph.json on disk
        // is from an earlier build, so comparing it would report a change that
        // was never measured: the batch is recorded as not verified, and passes.
        if graphRescanner == nil {
            let message = "\(Self.codeGraphUnverifiedPrefix) \(batch) not verified"
            appendLog(.info, "  [\(stage.name)] \(message)")
            return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: message,
                                   batchId: currentBatchId)
        }
        let load = await loadCodeGraph(stage, runRoot: runRoot)
        // A stale graph must never be compared: a batch that could not be
        // regenerated is not verified at all.
        if let reason = load.notRegenerated {
            let message = "graph not regenerated (\(reason)); batch \(batch) not verified"
            appendLog(.warn, "  [\(stage.name)] \(message)")
            return finishCodeGraph(stage, startedAt: startedAt, passed: false, output: message,
                                   batchId: currentBatchId)
        }
        guard let loaded = load.graph else {
            if graphRescanner == nil {
                appendLog(.info, "  [\(stage.name)] code graph not available in this build; verify skipped")
                return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: "")
            }
            return finishCodeGraph(stage, startedAt: startedAt, passed: false,
                                   output: "no graph.json after rescan")
        }
        let after = await Self.graphReport(loaded.index, runRoot: runRoot)
        do {
            try Self.writeGraphFile(loaded.data, to: LoopOutputLayout.refactorGraphAfter, root: mainRoot)
        } catch {
            return finishCodeGraph(stage, startedAt: startedAt, passed: false,
                                   output: "could not write the regenerated graph: \(error.localizedDescription)")
        }
        guard let before = graphBefore else {
            appendLog(.info, "  [\(stage.name)] no graph snapshot this run — nothing to compare")
            return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: "")
        }
        let delta = GraphReport.delta(before: before, after: after, expect: currentExpect)
        do {
            try Self.writeGraphFile(Data(delta.render(batchId: currentBatchId).utf8),
                                    to: LoopOutputLayout.refactorGraphDelta, root: mainRoot)
        } catch {
            appendLog(.warn, "  [\(stage.name)] could not write GRAPH-DELTA.md: \(error.localizedDescription)")
        }
        if !delta.regressions.isEmpty {
            let message = "structure regressed: \(delta.regressions.joined(separator: ", "))"
            return finishCodeGraph(stage, startedAt: startedAt, passed: false, output: message,
                                   batchId: currentBatchId, delta: delta.changes)
        }
        if delta.expectedMoved == false, let expect = currentExpect {
            let message = "batch \(batch) promised \(expect) to fall; it did not"
            return finishCodeGraph(stage, startedAt: startedAt, passed: false, output: message,
                                   batchId: currentBatchId, delta: delta.changes)
        }
        appendLog(.info, "  [\(stage.name)] graph delta · batch \(batch) · no regressions")
        return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: "",
                               batchId: currentBatchId, delta: delta.changes)
    }

    /// What a rescan left in the run root: the decoded graph (nil when there is
    /// none) and, when the rescan did not regenerate it, why.
    private struct GraphLoad {
        var graph: (index: GraphIndex, data: Data)?
        var notRegenerated: String?
    }

    /// Rescans through the injected rescanner (when there is one), then reads
    /// `graph.json` from `runRoot` once and decodes that same data.
    private func loadCodeGraph(_ stage: LoopStage, runRoot: URL) async -> GraphLoad {
        var notRegenerated: String?
        if let rescanner = graphRescanner {
            switch await rescanner.rescan(repoRoot: runRoot) {
            case .rewritten:
                appendLog(.info, "  [\(stage.name)] code graph regenerated")
            case .busy:
                notRegenerated = "a code-graph scan is already running"
            case .unavailable(let reason):
                notRegenerated = reason
            }
        }
        let url = runRoot.appendingPathComponent("system/graph/graph.json")
        guard let data = try? Data(contentsOf: url),
              let index = try? JSONDecoder().decode(GraphIndex.self, from: data) else {
            return GraphLoad(graph: nil, notRegenerated: notRegenerated)
        }
        return GraphLoad(graph: (index, data), notRegenerated: notRegenerated)
    }

    /// The counters for one graph, with the boundary-warning count when the
    /// project has the gate script. Probed in the run root, where the code is.
    private static func graphReport(_ index: GraphIndex, runRoot: URL) async -> GraphReport {
        let warnings = await BoundaryWarningsProbe.count(gitRoot: runRoot)
        return GraphReport.build(from: index, commit: gitHead(runRoot), boundaryWarnings: warnings)
    }

    private static func writeGraphFile(_ data: Data, to relativePath: String, root: URL) throws {
        let url = root.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    /// Records the attempt and settles the stage state. A failed `.codeGraph`
    /// stage honours severity: advisory proceeds, blocking ends the run.
    private func finishCodeGraph(_ stage: LoopStage, startedAt: Date, passed: Bool, output: String,
                                 batchId: String? = nil, delta: [String: Double]? = nil) -> StageDecision {
        stageStates[stage.id] = passed ? .passed : .failed
        record(stage, startedAt: startedAt, duration: Date().timeIntervalSince(startedAt),
               exitCode: nil, passed: passed, output: output, score: nil)
        if batchId != nil || delta != nil {
            annotateLastAttempt(stageId: stage.id) { attempt in
                attempt.batchId = batchId
                attempt.graphDelta = delta
            }
        }
        if passed || stage.severity == .advisory { return .proceed }
        return .terminate(.error(output))
    }

    // MARK: - Refactor batch capture

    /// Reads the plan the apply stage edits (its resolved Input), or nil.
    private func refactorPlanText(_ stage: LoopStage, gitRoot: URL, faultsRoot: URL) -> String? {
        guard let url = LoopStagePaths.resolve(stage, gitRoot: gitRoot, projectRoot: faultsRoot).input else {
            return nil
        }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - Batch rollback (Mikado, design doc §3.5, §5)

    /// Clears the rollback state of the batch in flight. Run start calls it;
    /// so must anything that moves the run on to another batch.
    func resetBatchRollbackState() {
        batchBaseTree = nil
        batchChangedPaths = []
        batchStarted = false
        batchTargetId = nil
        batchTrackingGap = nil
    }

    /// At the batch's first stage (§5.5): snapshot the working tree as the base
    /// a rollback restores to — before the test writer, so a rollback removes
    /// the batch's new tests too. Once per batch: a restart that re-enters the
    /// batch keeps the first base. A failed snapshot leaves this batch without
    /// rollback (it ends as it always did) and says so.
    func beginRefactorBatchIfNeeded(_ stage: LoopStage, gitRoot: URL) async {
        guard !batchStarted else { return }
        batchStarted = true
        // The batch a rollback names until Apply records which one it applied:
        // the same first `todo` batch `prepareNextBatchFile` hands the writer.
        let faultsRoot = currentRunContext?.faultsRoot ?? gitRoot
        batchTargetId = refactorPlanURL(gitRoot: gitRoot, faultsRoot: faultsRoot)
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
            .flatMap { RefactorPlanDiff.firstTodo(in: $0)?.id }
        batchBaseTree = await scopeGuard.snapshotTree(gitRoot: gitRoot)
        if batchBaseTree == nil {
            appendLog(.warn, "  [\(stage.name)] could not snapshot the working tree; a failed batch "
                      + "will be marked blocked but its edits will stay in the tree")
        }
    }

    /// The tree before one guarded edit while a batch is in flight; nil when
    /// none is (nothing to track) or the snapshot failed (a tracking gap).
    func batchTreeBeforeEdit(_ stage: LoopStage, gitRoot: URL) async -> String? {
        guard batchBaseTree != nil else { return nil }
        if let tree = await scopeGuard.snapshotTree(gitRoot: gitRoot) { return tree }
        noteBatchTrackingGap("could not snapshot the tree before \(stage.name)'s edit")
        return nil
    }

    /// Adds what one guarded edit changed (tree before → tree after) to the
    /// batch's rollback set. In a task of its own, like the scope check, so a
    /// Stop that cancelled the edit cannot also skip the bookkeeping.
    func recordBatchEdit(_ stage: LoopStage, since before: String, gitRoot: URL) async {
        let changed: [String]? = await Task { @MainActor in
            guard let after = await self.scopeGuard.snapshotTree(gitRoot: gitRoot) else { return nil }
            return await self.scopeGuard.treeDiff(from: before, to: after, gitRoot: gitRoot,
                                                  maxChars: 0, isQuotable: { _ in false })?.changedPaths
        }.value
        guard let changed else {
            noteBatchTrackingGap("could not tell what \(stage.name)'s edit changed")
            return
        }
        batchChangedPaths.formUnion(changed)
    }

    /// An edit whose paths could not be attributed makes the rollback set
    /// incomplete. Restoring the rest would leave half a batch in the tree, so
    /// a rollback then restores nothing (and still marks the batch blocked).
    private func noteBatchTrackingGap(_ reason: String) {
        if batchTrackingGap == nil { batchTrackingGap = reason }
        appendLog(.warn, "  rollback tracking: \(reason); a failed batch will not be rolled back")
    }

    /// Takes the failed batch back out of the tree and marks it blocked in the
    /// plan (§3.5): restores exactly `batchChangedPaths` — minus the refactor
    /// llm-doc directory and the plan — from `batchBaseTree`, worktree only,
    /// never the index; then rewrites the batch header to `(status: blocked)`
    /// with `- Blocked: <stage> — <first line of reason>` under it.
    ///
    /// Rolls back whenever the batch has STARTED (design doc §5.1, §5.5), not
    /// only once Apply ran: a run that ends between the writer and Apply must
    /// still take the writer's new tests back out, or every later run's
    /// baseline is red. The batch is `currentBatchId` once Apply recorded one,
    /// else `batchTargetId` (the first todo batch when the base was taken).
    /// Does nothing (returns false) when no batch started, the batch was
    /// skipped, or no batch can be named. Returns whether the tree was
    /// restored; the plan is marked blocked even when it was not (no base, a
    /// tracking gap, a failed restore), because the batch failed either way and
    /// leaving it `done` would let the next run stack another batch on top.
    @discardableResult
    func rollBackCurrentBatch(reason: String, stage: String) async -> Bool {
        guard batchStarted, !currentBatchSkipped, let ctx = currentRunContext else { return false }
        guard let batchId = currentBatchId ?? batchTargetId else {
            appendLog(.warn, "Refactor batch not rolled back: no plan batch could be named for it")
            return false
        }
        let planURL = refactorPlanURL(gitRoot: ctx.gitRoot, faultsRoot: ctx.faultsRoot)
        let planPath = planURL.flatMap { Self.repoRelativePath($0, in: ctx.gitRoot) }
        let paths = RefactorBatchRollback.restorePaths(batchChangedPaths, planPath: planPath)
        let blockedReason = RefactorBatchRollback.blockedReason(stageName: stage, summary: reason)
        let restoreProblem: String?
        if let base = batchBaseTree {
            if let gap = batchTrackingGap {
                restoreProblem = "\(gap), so the batch's edits are not all known"
            } else {
                restoreProblem = await scopeGuard.restore(paths: paths, fromTree: base, gitRoot: ctx.gitRoot)
            }
        } else {
            restoreProblem = "there is no snapshot of the tree from before the batch"
        }
        if let restoreProblem {
            appendLog(.error, "\(batchId) NOT rolled back: \(restoreProblem) — the batch's edits are still in the working tree")
        } else {
            appendLog(.warn, RefactorBatchRollback.rolledBackMessage(batchId: batchId))
            if !paths.isEmpty {
                appendLog(.info, "  restored \(paths.count) path(s): \(paths.joined(separator: ", "))")
            }
        }
        let planProblem = markPlanBlocked(planURL, batchId: batchId, reason: blockedReason)
        if let planProblem {
            appendLog(.warn, planProblem)
        } else {
            appendLog(.info, "\(batchId) marked blocked in the refactor plan: \(blockedReason)")
        }
        let problems = [restoreProblem, planProblem].compactMap { $0 }
        batchRollback = LoopBatchRollback(
            batchId: batchId, stageName: stage, reason: blockedReason, restoredPaths: paths,
            treeRestored: restoreProblem == nil,
            problem: problems.isEmpty ? nil : problems.joined(separator: "; "))
        return restoreProblem == nil
    }

    /// The plan the apply stage edits — resolved exactly as it resolves it
    /// (and as `prepareNextBatchFile` does when there is no apply stage), so
    /// the rollback marks the same file the batch was read from.
    private func refactorPlanURL(gitRoot: URL, faultsRoot: URL) -> URL? {
        let apply = runOrderedStages.first(where: { $0.isRefactorApply })
            ?? LoopStage(name: "Refactor Apply", kind: .skill, order: 0, skillId: "skills/refactor-apply",
                         targetPath: LoopOutputLayout.refactorPlan)
        return LoopStagePaths.resolve(apply, gitRoot: gitRoot, projectRoot: faultsRoot).input
    }

    /// Writes `(status: blocked)` and the reason into the plan; nil on success,
    /// else why not. Never fails the run: the verdict is already decided.
    private func markPlanBlocked(_ planURL: URL?, batchId: String, reason: String) -> String? {
        guard let planURL, let plan = try? String(contentsOf: planURL, encoding: .utf8) else {
            return "could not read the refactor plan to mark \(batchId) blocked"
        }
        guard RefactorPlanDiff.batch(id: batchId, in: plan) != nil else {
            return "\(batchId) is not in the refactor plan; not marked blocked"
        }
        do {
            try RefactorPlanDiff.markingBlocked(plan, id: batchId, reason: reason)
                .write(to: planURL, atomically: true, encoding: .utf8)
        } catch {
            return "could not mark \(batchId) blocked in the refactor plan: \(error.localizedDescription)"
        }
        return nil
    }

    /// `url`'s path relative to `root` (the form `treeDiff` reports), or nil
    /// when it is outside it — the split layout's project-level plan.
    private static func repoRelativePath(_ url: URL, in root: URL) -> String? {
        let rootPath = root.standardizedFileURL.resolvingSymlinksInPath().path
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : nil
    }

    /// Before the apply stage runs: remember the plan text and clear this batch's state.
    func captureRefactorPlanBefore(_ stage: LoopStage, gitRoot: URL, faultsRoot: URL) {
        refactorPlanBefore = refactorPlanText(stage, gitRoot: gitRoot, faultsRoot: faultsRoot)
        currentBatchId = nil
        currentExpect = nil
        currentBatchSkipped = false
    }

    /// After the apply stage ran: the batch whose status it changed, or the
    /// `Applied: R<n>` line of its reply when the plan itself did not change.
    /// Sets the batch the verify stage checks and stamps it on the apply attempt.
    func captureRefactorBatchAfter(_ stage: LoopStage, gitRoot: URL, faultsRoot: URL) {
        let before = refactorPlanBefore
        refactorPlanBefore = nil
        let after = refactorPlanText(stage, gitRoot: gitRoot, faultsRoot: faultsRoot)
        var applied: RefactorPlanDiff.Applied?
        if let before, let after {
            applied = RefactorPlanDiff.appliedBatch(before: before, after: after)
        }
        if applied == nil, let reply = lastSkillResults[stage.id]?.reply,
           let id = RefactorPlanDiff.appliedReplyBatchId(reply) {
            let planned = after.flatMap { RefactorPlanDiff.batch(id: id, in: $0) }
            if planned?.status != "done", planned?.status != "skipped" {
                appendLog(.warn, "  [\(stage.name)] plan status for \(id) unchanged; the next run will re-apply it")
            }
            applied = planned ?? RefactorPlanDiff.Applied(id: id, status: "done", expect: nil, files: [])
        }
        guard let applied else {
            appendLog(.info, "  [\(stage.name)] no refactor batch recorded as applied")
            return
        }
        let skipped = applied.status == "skipped"
        currentBatchId = applied.id
        currentExpect = skipped ? nil : applied.expect
        currentBatchSkipped = skipped
        annotateLastAttempt(stageId: stage.id) { $0.batchId = applied.id }
        appendLog(.info, "  [\(stage.name)] batch \(applied.id) \(skipped ? "skipped" : "applied")"
                  + (applied.expect.map { " · expects \($0) to fall" } ?? ""))
    }

    /// Sets a field on the most recent attempt recorded for `stageId`.
    func annotateLastAttempt(stageId: String, _ update: (inout LoopStageAttempt) -> Void) {
        guard !iterationRecords.isEmpty else { return }
        let last = iterationRecords.count - 1
        guard let index = iterationRecords[last].attempts.lastIndex(where: { $0.stageId == stageId }) else { return }
        update(&iterationRecords[last].attempts[index])
    }
    // MARK: - Next batch (the refactor test writer's Input)

    /// Writes the plan's first todo batch, verbatim, to `NEXT-BATCH.md` for the
    /// refactor test writer. Returns nil so the stage goes on to the agent; a
    /// decision when it must not: no todo batch (a passed skip, the agent is not
    /// called), the plan is missing or unreadable (failed: nothing to select a
    /// batch from, and the apply stage would then run with no tests written), or
    /// the file could not be written (failed). Any other stage: nil.
    func prepareNextBatchFile(stage: LoopStage, gitRoot: URL, startedAt: Date) -> StageDecision? {
        guard stage.isRefactorTestWrite else { return nil }
        let mainRoot = currentRunContext?.mainGitRoot ?? gitRoot
        let faultsRoot = currentRunContext?.faultsRoot ?? gitRoot
        // The plan is the apply stage's Input, resolved exactly as the apply
        // stage resolves it (repo, then project fallback), so both read one file.
        var planStage = runOrderedStages.first(where: { $0.isRefactorApply }) ?? stage
        if !planStage.isRefactorApply { planStage.targetPath = LoopOutputLayout.refactorPlan }
        let planPath = LoopStagePaths.resolve(planStage, gitRoot: gitRoot, projectRoot: faultsRoot).input
        guard let planURL = planPath else {
            return failNextBatch(stage, startedAt: startedAt,
                                 message: "refactor plan not found at \(LoopOutputLayout.refactorPlan); cannot select the next batch")
        }
        guard FileManager.default.fileExists(atPath: planURL.path) else {
            return failNextBatch(stage, startedAt: startedAt,
                                 message: "refactor plan not found at \(planURL.path); cannot select the next batch")
        }
        guard let plan = try? String(contentsOf: planURL, encoding: .utf8) else {
            return failNextBatch(stage, startedAt: startedAt,
                                 message: "could not read the refactor plan at \(planURL.path); cannot select the next batch")
        }
        guard let todo = RefactorPlanDiff.firstTodo(in: plan),
              let section = RefactorPlanDiff.section(of: todo.id, in: plan) else {
            let message = "no todo batch in the refactor plan"
            stageStates[stage.id] = .passed
            appendLog(.info, "  [\(stage.name)] \(message); skipped")
            record(stage, startedAt: startedAt, duration: Date().timeIntervalSince(startedAt),
                   exitCode: nil, passed: true, output: message, score: nil)
            return .proceed
        }
        // The confined writer reads its Input in the run root; mirror to the main
        // checkout too when they differ, so the Loop's own output sits beside the plan.
        let data = Data((section + "\n").utf8)
        do {
            try Self.writeGraphFile(data, to: LoopOutputLayout.refactorNextBatch, root: gitRoot)
            if gitRoot.standardizedFileURL.path != mainRoot.standardizedFileURL.path {
                try Self.writeGraphFile(data, to: LoopOutputLayout.refactorNextBatch, root: mainRoot)
            }
        } catch {
            return failNextBatch(stage, startedAt: startedAt,
                                 message: "could not write the next batch: \(error.localizedDescription)")
        }
        appendLog(.info, "  [\(stage.name)] batch \(todo.id) written to NEXT-BATCH.md")
        return nil
    }

    /// Fails the test-write stage before the agent runs and ends the run.
    private func failNextBatch(_ stage: LoopStage, startedAt: Date, message: String) -> StageDecision {
        stageStates[stage.id] = .failed
        appendLog(.error, "  [\(stage.name)] \(message)")
        record(stage, startedAt: startedAt, duration: Date().timeIntervalSince(startedAt),
               exitCode: nil, passed: false, output: message, score: nil)
        return .terminate(.error(message))
    }
}

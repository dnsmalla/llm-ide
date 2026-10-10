import Foundation

// The Refactoring loop's `.codeGraph` stage and its batch capture, kept out of
// LoopEngineRunner.swift. Run state (`graphBefore`, `currentBatchId`,
// `currentExpect`, `currentBatchSkipped`, `refactorPlanBefore`) lives on the
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
        guard stage.testWriteOnly, (stage.targetPath ?? "").hasSuffix("NEXT-BATCH.md") else { return nil }
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

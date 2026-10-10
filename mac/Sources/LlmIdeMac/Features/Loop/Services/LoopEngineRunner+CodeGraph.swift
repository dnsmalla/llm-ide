import Foundation

// The Refactoring loop's `.codeGraph` stage and its batch capture, kept out of
// LoopEngineRunner.swift. Run state (`graphBefore`, `currentBatchId`,
// `currentExpect`, `currentBatchSkipped`, `refactorPlanBefore`) lives on the
// runner; extensions cannot hold stored properties. Features/Loop does not
// import the code-graph module: the graph arrives through `GraphRescanning`.
extension LoopEngineRunner {

    // MARK: - Stage

    func runCodeGraphStage(_ stage: LoopStage, gitRoot: URL) async -> StageDecision {
        let startedAt = Date()
        // The graph and its snapshots live under the main checkout, like every
        // other Loop output (`system/` is gitignored, so a worktree would lose them).
        let mainRoot = currentRunContext?.mainGitRoot ?? gitRoot
        switch stage.graphOp {
        case .snapshot:
            return await runGraphSnapshot(stage, startedAt: startedAt, mainRoot: mainRoot)
        case .verify:
            return await runGraphVerify(stage, startedAt: startedAt, mainRoot: mainRoot)
        case nil:
            stageStates[stage.id] = .failed
            return .terminate(.error("Stage \"\(stage.name)\" has no operation chosen"))
        }
    }

    private func runGraphSnapshot(_ stage: LoopStage, startedAt: Date, mainRoot: URL) async -> StageDecision {
        guard let loaded = await loadCodeGraph(stage, mainRoot: mainRoot) else {
            if graphRescanner == nil {
                appendLog(.info, "  [\(stage.name)] code graph not available in this build; snapshot skipped")
                return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: "")
            }
            return finishCodeGraph(stage, startedAt: startedAt, passed: false,
                                   output: "no graph.json after rescan")
        }
        let report = await Self.graphReport(loaded.index, mainRoot: mainRoot)
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

    private func runGraphVerify(_ stage: LoopStage, startedAt: Date, mainRoot: URL) async -> StageDecision {
        if currentBatchSkipped {
            let id = currentBatchId ?? "unknown"
            let message = "batch \(id) was skipped; nothing to verify"
            appendLog(.info, "  [\(stage.name)] \(message)")
            return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: message)
        }
        guard let loaded = await loadCodeGraph(stage, mainRoot: mainRoot) else {
            if graphRescanner == nil {
                appendLog(.info, "  [\(stage.name)] code graph not available in this build; verify skipped")
                return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: "")
            }
            return finishCodeGraph(stage, startedAt: startedAt, passed: false,
                                   output: "no graph.json after rescan")
        }
        let after = await Self.graphReport(loaded.index, mainRoot: mainRoot)
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
        let id = currentBatchId ?? "unknown"
        if !delta.regressions.isEmpty {
            let message = "structure regressed: \(delta.regressions.joined(separator: ", "))"
            return finishCodeGraph(stage, startedAt: startedAt, passed: false, output: message,
                                   batchId: currentBatchId, delta: delta.changes)
        }
        if delta.expectedMoved == false, let expect = currentExpect {
            let message = "batch \(id) promised \(expect) to fall; it did not"
            return finishCodeGraph(stage, startedAt: startedAt, passed: false, output: message,
                                   batchId: currentBatchId, delta: delta.changes)
        }
        appendLog(.info, "  [\(stage.name)] graph delta · batch \(id) · no regressions")
        return finishCodeGraph(stage, startedAt: startedAt, passed: true, output: "",
                               batchId: currentBatchId, delta: delta.changes)
    }

    /// Rescans through the injected rescanner (when there is one), then loads
    /// `graph.json`. A busy or unavailable rescan is soft: the existing file is used.
    private func loadCodeGraph(_ stage: LoopStage, mainRoot: URL) async -> (index: GraphIndex, data: Data)? {
        if let rescanner = graphRescanner {
            switch await rescanner.rescan(repoRoot: mainRoot) {
            case .rewritten:
                appendLog(.info, "  [\(stage.name)] code graph regenerated")
            case .busy:
                appendLog(.warn, "  [\(stage.name)] a code-graph scan is already running — using the existing graph.json")
            case .unavailable(let reason):
                appendLog(.warn, "  [\(stage.name)] code graph not regenerated (\(reason)) — using the existing graph.json")
            }
        }
        let url = mainRoot.appendingPathComponent("system/graph/graph.json")
        guard let data = try? Data(contentsOf: url),
              let index = GraphIndex.load(gitRoot: mainRoot) else { return nil }
        return (index, data)
    }

    /// The counters for one graph, with the boundary-warning count when the
    /// project has the gate script.
    private static func graphReport(_ index: GraphIndex, mainRoot: URL) async -> GraphReport {
        let warnings = await BoundaryWarningsProbe.count(gitRoot: mainRoot)
        return GraphReport.build(from: index, commit: gitHead(mainRoot), boundaryWarnings: warnings)
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

    /// Sets a field on the most recent attempt recorded for `stageId`.
    func annotateLastAttempt(stageId: String, _ update: (inout LoopStageAttempt) -> Void) {
        guard !iterationRecords.isEmpty else { return }
        let last = iterationRecords.count - 1
        guard let index = iterationRecords[last].attempts.lastIndex(where: { $0.stageId == stageId }) else { return }
        update(&iterationRecords[last].attempts[index])
    }
}

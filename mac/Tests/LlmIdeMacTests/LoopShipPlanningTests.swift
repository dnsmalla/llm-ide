import Testing
import Foundation
@testable import LlmIdeMacLib

/// When a Loop run's edits are shipped as a merge request — and what the request
/// says. A request must only come from a run that really succeeded, only from
/// the files that run changed, and never copy stage output into its description.
@Suite("Loop shipping decisions")
struct LoopShipPlanningTests {
    private func attempt(_ stage: String, passed: Bool = true, repaired: Bool = false,
                         paths: [String] = [], verdict: RepairScopeVerdict = .notChecked,
                         output: String = "") -> LoopStageAttempt {
        LoopStageAttempt(stageId: "id-\(stage)", stageName: stage, kind: .shellCommand, severity: .blocking,
                         startedAt: Date(timeIntervalSince1970: 0), durationSeconds: 1, exitCode: passed ? 0 : 1,
                         passed: passed, outputTail: output, outputHash: nil, score: nil,
                         repairAttempted: repaired, changedPaths: paths, scopeVerdict: verdict)
    }

    private func record(status: String = "success", iterations: [[LoopStageAttempt]]) -> LoopRunRecord {
        LoopRunRecord(
            id: "run-1", projectId: "p", trigger: .manual, gitRoot: "/tmp/repo",
            startedAt: Date(timeIntervalSince1970: 0), endedAt: Date(timeIntervalSince1970: 42),
            iterationsUsed: iterations.count, config: LoopRunConfigSnapshot(LoopEngineConfig(stages: [])),
            iterations: iterations.enumerated().map { LoopIterationRecord(index: $0.offset + 1, attempts: $0.element) },
            statusCode: status, statusSummary: status == "success" ? "success" : "failed", loopId: "l", loopName: "Regression")
    }

    @Test("only a successful run of a loop that opted in is shipped")
    func decision() {
        typealias P = LoopShipPlanning
        #expect(P.decide(statusCode: "success", openMergeRequest: true, ranInWorktree: false, touchedProtectedPath: false) == .ship)
        for failed in ["error", "blocked.environment", "aborted", "givenUp.noProgress"] {
            #expect(P.decide(statusCode: failed, openMergeRequest: true, ranInWorktree: false, touchedProtectedPath: false) == .notApplicable,
                    "\(failed) must never ship")
        }
        #expect(P.decide(statusCode: "success", openMergeRequest: false, ranInWorktree: false, touchedProtectedPath: false) == .notApplicable)
        if case .skip(let reason) = P.decide(statusCode: "success", openMergeRequest: true, ranInWorktree: true, touchedProtectedPath: false) {
            #expect(reason.contains("worktree"))
        } else { Issue.record("a worktree run keeps its changes for review") }
        if case .skip(let reason) = P.decide(statusCode: "success", openMergeRequest: true, ranInWorktree: false, touchedProtectedPath: true) {
            #expect(reason.contains("protected"))
        } else { Issue.record("a left-in-place protected edit must not be shipped on the run's own authority") }
    }

    @Test("changed paths: first-seen order, no duplicates, repo-relative only")
    func changedPaths() {
        let r = record(iterations: [
            [attempt("Test", paths: ["a.py", "b.py"])],
            [attempt("Test", paths: ["b.py", "c.py", "/Users/me/notes/plan.md", "../outside.md"])],
        ])
        #expect(LoopShipPlanning.changedPaths(in: r) == ["a.py", "b.py", "c.py"])
        #expect(LoopShipPlanning.changedPaths(in: record(iterations: [[attempt("Test")]])).isEmpty)
    }

    @Test("a violated scope verdict is detected; a reverted one is not")
    func protectedPath() {
        #expect(LoopShipPlanning.touchedProtectedPath(in: record(iterations: [[attempt("T", verdict: .violated)]])))
        #expect(!LoopShipPlanning.touchedProtectedPath(in: record(iterations: [[attempt("T", verdict: .violatedReverted)]])))
        #expect(!LoopShipPlanning.touchedProtectedPath(in: record(iterations: [[attempt("T", verdict: .clean)]])))
    }

    @Test("shippable paths: what git still lists, a rename's both names, in the run's order")
    func shippable() {
        let entries = ShipPlanning.statusEntries(porcelainZ: " M a.py\0?? new.py\0R  renamed.py\0old.py\0?? 日本語.txt\0 M untouched-by-loop.py\0")
        #expect(LoopShipPlanning.shippablePaths(entries: entries, among: ["a.py", "new.py", "renamed.py", "日本語.txt", "gone.py"])
                == ["a.py", "new.py", "renamed.py", "old.py", "日本語.txt"],
                "the old name is shipped too, so the rename is one change; a path git no longer lists (already committed) is not")
        #expect(LoopShipPlanning.shippablePaths(entries: [], among: ["a.py"]).isEmpty)
    }

    @Test("files the user was already editing are never shipped")
    func overlap() {
        #expect(LoopShipPlanning.overlap(files: ["a.py", "b.py", "c.py"], baseline: ["b.py", "other.py"]) == ["b.py"])
        #expect(LoopShipPlanning.overlap(files: ["a.py"], baseline: []).isEmpty)
    }

    @Test("the request says what happened, and never copies stage output")
    func description() {
        let r = record(iterations: [
            [attempt("Test", passed: false, repaired: true, output: "AWS_SECRET_ACCESS_KEY=abc123 /Users/me/secret"),
             attempt("Lint")],
            [attempt("Test", passed: true)],
        ])
        let text = LoopShipPlanning.description(record: r, files: ["a.py", "b.py"])
        #expect(text.contains("Regression") && text.contains("Nothing was merged"))
        #expect(text.contains("run-1") && text.contains("2 iterations") && text.contains("42 s"))
        #expect(text.contains("Repair attempts: 1"))
        #expect(text.contains("✅ Test (repaired)"), "the stage's FINAL attempt decides its mark")
        #expect(text.contains("✅ Lint") && text.contains("`a.py`") && text.contains("Files changed (2)"))
        #expect(!text.contains("AWS_SECRET") && !text.contains("/Users/me"), "stage output must never reach the request")
        let many = LoopShipPlanning.description(record: r, files: (1...80).map { "f\($0).py" })
        #expect(many.contains("and 30 more") && many.count <= 6_000)
    }

    @Test("commit message and title read as one-liners and pluralise")
    func wording() {
        #expect(LoopShipPlanning.title(loopName: "Doc\nOptimization", fileCount: 1) == "Loop “Doc Optimization”: repairs to 1 file")
        let message = LoopShipPlanning.commitMessage(loopName: "Regression", fileCount: 3, runId: "run-9")
        #expect(message.hasPrefix("fix: loop Regression repairs (3 files)\n\n"))
        #expect(message.contains("run-9"))
        #expect(LoopShipPlanning.commitMessage(loopName: "  ", fileCount: 1, runId: "r").hasPrefix("fix: loop loop repairs (1 file)"))
    }

    @Test("a loop.json written before this existed still decodes, with opening requests ON")
    func configDefault() throws {
        let old = #"{"stages":[],"maxIterations":4}"#.data(using: .utf8)!
        let config = try JSONDecoder().decode(LoopEngineConfig.self, from: old)
        #expect(config.openMergeRequest, "an absent key means the default (on)")
        var off = config; off.openMergeRequest = false
        let roundTrip = try JSONDecoder().decode(LoopEngineConfig.self, from: JSONEncoder().encode(off))
        #expect(!roundTrip.openMergeRequest, "an explicit opt-out survives a save")
    }

    @Test("a record written before shipments existed decodes, and one with a shipment round-trips")
    func recordCompat() throws {
        var r = record(iterations: [[attempt("Test")]])
        #expect(r.shipment == nil)
        r.shipment = LoopShipment(status: .shipped, summary: "Opened merge request !9: https://x/9",
                                  mergeRequestURL: "https://x/9", branch: "loop/regression-1", files: ["a.py"])
        let decoded = try JSONDecoder().decode(LoopRunRecord.self, from: JSONEncoder().encode(r))
        #expect(decoded.shipment == r.shipment)
        // Strip the key: an older journal entry.
        var object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(r)) as? [String: Any])
        object.removeValue(forKey: "shipment")
        let old = try JSONDecoder().decode(LoopRunRecord.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(old.shipment == nil)
    }
}

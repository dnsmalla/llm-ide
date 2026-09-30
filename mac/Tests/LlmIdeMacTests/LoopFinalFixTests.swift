import XCTest
@testable import LlmIdeMacLib

/// Final whole-branch review fixes for the Loop runner. Reuses the stubs in
/// `LoopPhase1FixTests`.
@MainActor
final class LoopFinalFixTests: XCTestCase {
    typealias P1 = LoopPhase1FixTests

    override func tearDown() {
        LoopRunQueue._resetForTesting()
        LoopWorktreeManager._resetForTesting()
        super.tearDown()
    }

    /// A skill agent that writes each stage's Output (a small markdown file),
    /// so the shipped artifact check has real files to pass on.
    final class WritingSkillExecutor: LoopSkillExecuting {
        var outputs: [String: String]   // skillId → repo-relative file to write
        var failing: Set<String> = []   // skillIds whose call throws
        private(set) var calls: [String] = []
        init(outputs: [String: String]) { self.outputs = outputs }
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
            calls.append(skillId)
            if failing.contains(skillId) { throw URLError(.cannotConnectToHost) }
            if let rel = outputs[skillId] {
                let url = repoRoot.appendingPathComponent(rel)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                        withIntermediateDirectories: true)
                try Data("# Generated\n\nShort page.\n".utf8).write(to: url)
            }
            return LoopAgentResult()
        }
    }

    private func makeRepo() throws -> URL {
        let repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("final-fix-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: repo) }
        return repo.resolvingSymlinksInPath()
    }

    private func runner(skills: LoopSkillExecuting, journal: P1.Journal,
                        verifier: FaultVerifier = P1.Verifier { _ in VerifyOutcome(exitCode: 0, output: "") },
                        approvals: VerifyApprovalStore? = nil) -> LoopEngineRunner {
        LoopEngineRunner(verifier: verifier, stageRepairer: P1.Repairer(),
                         regressionSweep: P1.Sweep(), skillExecutor: skills,
                         approvals: approvals ?? VerifyApprovalStore(
                            defaults: UserDefaults(suiteName: "ffix-\(UUID().uuidString)")!),
                         stageTimeout: 600, journal: journal, summaryWriter: P1.Summary(),
                         scopeGuard: P1.CancellationSensitiveGuard(violation: []),
                         repoRegistrar: nil, transportRetryDelay: 0)
    }

    // MARK: - Item 1: shipped Plan/Docs checks pass preflight

    private func runShipped(_ loopKey: String, outputs: [String: String]) async throws
        -> (LoopEngineStatus?, P1.Journal, [LoopStage]) {
        let repo = try makeRepo()
        let stages = LoopStageDetector.defaultStages(forLoop: loopKey, gitRoot: repo)
        XCTAssertEqual(stages.last?.kind, .artifactCheck)
        XCTAssertTrue(stages.last?.check?.requiredPaths.isEmpty ?? false,
                      "the shipped check carries only outputRules — the case preflight used to reject")
        let journal = P1.Journal()
        let r = runner(skills: WritingSkillExecutor(outputs: outputs), journal: journal)
        let status = await r.run(config: LoopEngineConfig(stages: stages, maxIterations: 1),
                                 faultsRoot: repo, gitRoot: repo)
        return (status, journal, stages)
    }

    func testShippedPlanLoopReachesIterationOneAndRunsItsCheck() async throws {
        let (status, journal, stages) = try await runShipped(LoopDefaultLoopKey.plan, outputs: [
            "skills/plan-structure-index": "llm-doc/plans/INDEX.md",
            "skills/plan-director": "llm-doc/plans/PLAN.md",
        ])
        let attempts = journal.written.last?.iterations.first?.attempts ?? []
        let check = attempts.first { $0.stageId == stages.last?.id }
        XCTAssertNotNil(check, "the check executed in iteration 1")
        XCTAssertEqual(check?.passed, true)
        XCTAssertEqual(status, .success)
    }

    func testShippedDocsLoopReachesIterationOneAndRunsItsCheck() async throws {
        let (status, journal, stages) = try await runShipped(LoopDefaultLoopKey.docs, outputs: [
            "skills/doc-structure-index": "llm-doc/docs/INDEX.md",
            "skills/doc-writer": "llm-doc/docs/area.md",
        ])
        let attempts = journal.written.last?.iterations.first?.attempts ?? []
        let check = attempts.first { $0.stageId == stages.last?.id }
        XCTAssertNotNil(check, "the check executed in iteration 1")
        XCTAssertEqual(check?.passed, true)
        XCTAssertEqual(status, .success)
    }

    func testBlankedOutputStillFailsPreflight() async throws {
        let repo = try makeRepo()
        var stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.plan, gitRoot: repo)
        for i in stages.indices where stages[i].kind == .skill { stages[i].outputPath = "  " }
        let journal = P1.Journal()
        let skills = WritingSkillExecutor(outputs: [:])
        let status = await runner(skills: skills, journal: journal)
            .run(config: LoopEngineConfig(stages: stages, maxIterations: 1), faultsRoot: repo, gitRoot: repo)
        guard case .error(let message)? = status else { return XCTFail("expected .error, got \(String(describing: status))") }
        XCTAssertTrue(message.contains("no checks configured"), message)
        XCTAssertEqual(skills.calls, [], "preflight stops before any agent call")
    }
}

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
            "skills/plan-structure-index": "llm-doc/loop/plan/INDEX.md",
            "skills/plan-director": "llm-doc/loop/plan/PLAN.md",
        ])
        let attempts = journal.written.last?.iterations.first?.attempts ?? []
        let check = attempts.first { $0.stageId == stages.last?.id }
        XCTAssertNotNil(check, "the check executed in iteration 1")
        XCTAssertEqual(check?.passed, true)
        XCTAssertEqual(status, .success)
    }

    func testShippedDocsLoopReachesIterationOneAndRunsItsCheck() async throws {
        let (status, journal, stages) = try await runShipped(LoopDefaultLoopKey.docs, outputs: [
            "skills/doc-structure-index": "llm-doc/loop/docs/INDEX.md",
            "skills/doc-writer": "llm-doc/loop/docs/area.md",
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

// MARK: - Item 2: a passing verify stage does not launder an errored stage

@MainActor
final class LoopHonestVerdictTests: XCTestCase {
    private func attempt(_ id: String, _ kind: LoopStage.Kind, passed: Bool,
                         errored: Bool? = nil) -> LoopStageAttempt {
        LoopStageAttempt(stageId: id, stageName: id, kind: kind, severity: .blocking,
                         startedAt: Date(), durationSeconds: 0, exitCode: nil, passed: passed,
                         outputTail: errored == true ? "connection refused" : "", outputHash: nil,
                         score: nil, errored: errored)
    }

    func testErroredApplyWithPassingTestsIsError() {
        let iterations = [LoopIterationRecord(index: 1, attempts: [
            attempt("Refactor Apply", .skill, passed: false, errored: true),
            attempt("Test", .shellCommand, passed: true),
        ])]
        let verdict = LoopEngineRunner.honestVerdict(.success, iterations: iterations)
        guard case .error(let message) = verdict else { return XCTFail("got \(verdict)") }
        XCTAssertTrue(message.contains("\"Refactor Apply\""), message)
    }

    func testErroredThenCleanSkillWithPassingVerifyIsSuccess() {
        let iterations = [
            LoopIterationRecord(index: 1, attempts: [
                attempt("Fix", .skill, passed: false, errored: true),
                attempt("Test", .shellCommand, passed: false),
            ]),
            LoopIterationRecord(index: 2, attempts: [
                attempt("Fix", .skill, passed: true),
                attempt("Test", .shellCommand, passed: true),
            ]),
        ]
        XCTAssertEqual(LoopEngineRunner.honestVerdict(.success, iterations: iterations), .success)
    }

    func testCleanThenErroredSkillIsError() {
        let iterations = [
            LoopIterationRecord(index: 1, attempts: [attempt("Fix", .skill, passed: true)]),
            LoopIterationRecord(index: 2, attempts: [
                attempt("Fix", .skill, passed: false, errored: true),
                attempt("Test", .shellCommand, passed: true),
            ]),
        ]
        guard case .error = LoopEngineRunner.honestVerdict(.success, iterations: iterations) else {
            return XCTFail("the last attempt errored")
        }
    }
}

// MARK: - Item 4: the Loop page sees and stops lane runs

@MainActor
final class LoopLaneRunRoutingTests: XCTestCase {
    typealias P1 = LoopPhase1FixTests

    override func tearDown() {
        LoopRunQueue._resetForTesting()
        LoopWorktreeManager._resetForTesting()
        super.tearDown()
    }

    /// Records whether the page could see the lane run while a stage ran.
    final class ObservingSkill: LoopSkillExecuting {
        var observe: @MainActor () -> Void = {}
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
            await observe()
            return LoopAgentResult()
        }
    }

    func testStopTargetPrefersTheDesktopRunThenTheLane() {
        XCTAssertEqual(LoopRunService.stopTarget(desktopActive: true, laneActive: true), .desktop)
        XCTAssertEqual(LoopRunService.stopTarget(desktopActive: false, laneActive: true), .lane)
        XCTAssertEqual(LoopRunService.stopTarget(desktopActive: false, laneActive: false), .none)
    }

    func testLaneRunIsVisibleWhileAdmittedAndItsStopRoutesToTheLane() async {
        let service = LoopRunService(api: LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456"))
        var laneCancels = 0
        service.cancelLoopLane = { laneCancels += 1 }
        let skill = ObservingSkill()
        let runner = LoopEngineRunner(
            verifier: P1.Verifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: P1.Repairer(), regressionSweep: P1.Sweep(), skillExecutor: skill,
            approvals: VerifyApprovalStore(defaults: UserDefaults(suiteName: "lane-\(UUID().uuidString)")!),
            stageTimeout: 600, journal: P1.Journal(), summaryWriter: P1.Summary(),
            scopeGuard: P1.CancellationSensitiveGuard(violation: []), repoRegistrar: nil,
            transportRetryDelay: 0)
        service.attachLaneRunner(runner, trigger: .phone)
        var seen: LoopRunService.LaneRun?
        skill.observe = {
            seen = service.laneRun(projectId: "p", loopId: "L")
            service.stopShownRun(projectId: "p", loopId: "L")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lane-\(UUID().uuidString)")
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s", name: "Plan", kind: .skill, order: 0, skillId: "fam/plan")
        ], maxIterations: 1)
        _ = await runner.run(config: config, faultsRoot: root, gitRoot: root, projectId: "p", loopId: "L")

        XCTAssertTrue(seen?.runner === runner, "the page sees the lane run while it is in flight")
        XCTAssertEqual(seen?.label, "Running (started from phone)")
        XCTAssertEqual(laneCancels, 1, "the page's Stop reached the lane")
        XCTAssertNil(service.laneRun(projectId: "p", loopId: "L"), "cleared once the run ends")
        XCTAssertNil(service.laneRun(projectId: "p", loopId: "other"))
    }
}

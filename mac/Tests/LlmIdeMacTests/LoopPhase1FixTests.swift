import XCTest
@testable import LlmIdeMacLib

/// Phase 1 review fixes for the Loop runner (P1–P9 of the 2026-09-30 review).
/// Own stubs, so the large `LoopEngineRunnerTests` fixtures stay untouched.
@MainActor
final class LoopPhase1FixTests: XCTestCase {

    override func tearDown() {
        LoopRunQueue._resetForTesting()
        LoopWorktreeManager._resetForTesting()
        super.tearDown()
    }

    private let repoRoot = URL(fileURLWithPath: "/tmp/phase1-fix-\(UUID().uuidString)")

    // MARK: - Stubs

    final class Verifier: FaultVerifier {
        var handler: (String) -> VerifyOutcome
        init(_ handler: @escaping (String) -> VerifyOutcome) { self.handler = handler }
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            handler(command)
        }
    }

    final class Repairer: LoopStageRepairer {
        var body: () async throws -> LoopAgentResult = { LoopAgentResult() }
        private(set) var calls = 0
        private(set) var timeouts: [TimeInterval?] = []
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL, timeout: TimeInterval?) async throws -> LoopAgentResult {
            calls += 1
            timeouts.append(timeout)
            return try await body()
        }
    }

    final class SkillExecutor: LoopSkillExecuting {
        var result = LoopAgentResult()
        private(set) var calls = 0
        private(set) var extraRoots: [[URL]] = []
        private(set) var timeouts: [TimeInterval?] = []
        func execute(skillId: String, targetPath: String?, message: String,
                     repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
            calls += 1
            timeouts.append(timeout)
            self.extraRoots.append(extraRoots)
            return result
        }
    }

    final class Sweep: RegressionSweepRunning {
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
                   repairGuard: FaultRepairGuard?) async -> SweepOutcome {
            SweepOutcome(passed: true, total: 0, regressed: 0, unchanged: 0, repaired: 0,
                         repairFailed: 0, needsApproval: 0, failed: 0, pending: 0)
        }
    }

    final class Journal: LoopRunJournaling {
        private(set) var written: [LoopRunRecord] = []
        func write(_ record: LoopRunRecord, root: URL) -> String? { written.append(record); return nil }
        func recentRuns(root: URL, limit: Int) -> [LoopRunIndexEntry] { [] }
    }

    final class Summary: LoopRunSummaryWriting {
        func write(_ record: LoopRunRecord, root: URL) async -> LoopSummaryNoteResult {
            .written(path: "llm-doc/loop/x.md")
        }
    }

    /// Answers like git would: a probe made from a CANCELLED task fails
    /// (`.indeterminate`), which is exactly what the Stop path used to hit.
    final class CancellationSensitiveGuard: RepairScopeGuarding {
        var violation: [String]
        private(set) var reverted: [String] = []
        private(set) var checkedWhileCancelled = false
        init(violation: [String]) { self.violation = violation }
        func snapshot(gitRoot: URL, protectedGlobs: [String], scopeGlobs: [String]) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck {
            if Task.isCancelled {
                checkedWhileCancelled = true
                return .indeterminate(reason: "git status failed: cancelled")
            }
            return violation.isEmpty ? .clean(changedPaths: [])
                : .violated(paths: violation, allChangedPaths: violation)
        }
        func revert(paths: [String], gitRoot: URL) async -> String? {
            reverted.append(contentsOf: paths)
            violation.removeAll { paths.contains($0) }   // a reverted path is clean on the next check
            return nil
        }
        private(set) var revertedUnlisted: [String] = []
        private(set) var unlistedCreated: Set<String> = []
        func revertUnlisted(paths: [String], created: Set<String>, gitRoot: URL) async -> String? {
            revertedUnlisted.append(contentsOf: paths)
            unlistedCreated = created
            return nil
        }
    }

    private func approvals(_ stages: [(String, String)]) -> VerifyApprovalStore {
        let store = VerifyApprovalStore(defaults: UserDefaults(suiteName: "p1fix-\(UUID().uuidString)")!)
        for (id, command) in stages { store.approveStage(repo: repoRoot, stageId: id, command: command) }
        return store
    }

    private func runner(verifier: FaultVerifier = Verifier { _ in VerifyOutcome(exitCode: 0, output: "") },
                        repairer: LoopStageRepairer = Repairer(),
                        skills: LoopSkillExecuting = SkillExecutor(),
                        approvals: VerifyApprovalStore,
                        journal: Journal = Journal(),
                        stageTimeout: TimeInterval = 600,
                        registrar: LoopRepoRegistering? = nil,
                        scopeGuard: RepairScopeGuarding) -> LoopEngineRunner {
        LoopEngineRunner(verifier: verifier, stageRepairer: repairer, regressionSweep: Sweep(),
                         skillExecutor: skills, approvals: approvals, stageTimeout: stageTimeout,
                         journal: journal, summaryWriter: Summary(), scopeGuard: scopeGuard,
                         repoRegistrar: registrar, transportRetryDelay: 0)
    }

    // MARK: - P2: a Stop mid-edit still runs the guard

    func testStopMidRepairStillChecksAndRevertsProtectedEdit() async {
        let started = expectation(description: "repair started")
        let repairer = Repairer()
        repairer.body = {
            started.fulfill()
            // The agent has already written the test file; the Stop lands now.
            try await Task.sleep(nanoseconds: 30_000_000_000)
            return LoopAgentResult()
        }
        let scope = CancellationSensitiveGuard(violation: ["Tests/FooTests.swift"])
        let journal = Journal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 3, protectedPathPolicy: .revert)
        let r = runner(verifier: Verifier { _ in VerifyOutcome(exitCode: 1, output: "1 failure") },
                       repairer: repairer, approvals: approvals([("t", "swift test")]),
                       journal: journal, scopeGuard: scope)
        let root = repoRoot
        let task = Task { await r.run(config: config, faultsRoot: root, gitRoot: root) }
        await fulfillment(of: [started], timeout: 10)
        task.cancel()
        let status = await task.value

        XCTAssertEqual(status, .aborted, "the cancellation still propagates")
        XCTAssertFalse(scope.checkedWhileCancelled, "the check must not run in the cancelled task")
        XCTAssertEqual(scope.reverted, ["Tests/FooTests.swift"], "the protected edit is reverted under .revert")
        let attempt = journal.written.last?.iterations.last?.attempts.last
        XCTAssertEqual(attempt?.scopeVerdict, .violatedReverted)
        XCTAssertEqual(attempt?.changedPaths, ["Tests/FooTests.swift"])
    }

    // MARK: - P1: split layout — the skill agent reaches <project>/llm-doc

    private func makeSplitProject() throws -> (project: URL, repo: URL) {
        let project = FileManager.default.temporaryDirectory
            .appendingPathComponent("p1fix-split-\(UUID().uuidString)", isDirectory: true)
        let repo = project.appendingPathComponent("code/app", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("system"),
                                                withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: project.appendingPathComponent("system/project.json"))
        addTeardownBlock { try? FileManager.default.removeItem(at: project) }
        return (project.resolvingSymlinksInPath(), repo.resolvingSymlinksInPath())
    }

    private func skillConfig() -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "plan", name: "Plan", kind: .skill, order: 0, skillId: "fam/plan")
        ], maxIterations: 1)
    }

    func testSplitLayoutSkillRunSendsTheProjectLlmDoc() async throws {
        let (project, repo) = try makeSplitProject()
        let skills = SkillExecutor()
        let r = runner(skills: skills, approvals: approvals([]), scopeGuard: CancellationSensitiveGuard(violation: []))
        _ = await r.run(config: skillConfig(), faultsRoot: project, gitRoot: repo)

        let llmDoc = project.appendingPathComponent("llm-doc", isDirectory: true)
        XCTAssertEqual(skills.extraRoots.map { $0.map(\.path) }, [[llmDoc.path]])
        XCTAssertTrue(FileManager.default.fileExists(atPath: llmDoc.path), "created when missing")
    }

    func testSkillExtraRootsOnlyForAnOutsideLlmDocOfARealProject() throws {
        let (project, repo) = try makeSplitProject()
        XCTAssertEqual(LoopEngineRunner.skillExtraRoots(projectRoot: project, gitRoot: project), [],
                       "project root IS the repo: llm-doc is already inside")
        let deep = project.appendingPathComponent("a/b/c/d")
        XCTAssertEqual(LoopEngineRunner.skillExtraRoots(projectRoot: project, gitRoot: deep), [],
                       "more than 3 levels down — the server would refuse it")
        let unrelated = FileManager.default.temporaryDirectory.appendingPathComponent("elsewhere")
        XCTAssertEqual(LoopEngineRunner.skillExtraRoots(projectRoot: project, gitRoot: unrelated), [])
        try FileManager.default.removeItem(at: project.appendingPathComponent("system/project.json"))
        XCTAssertEqual(LoopEngineRunner.skillExtraRoots(projectRoot: project, gitRoot: repo), [],
                       "not an LLM-IDE project")
    }

    func testRequestCarriesExtraRootsOnlyWhenSet() throws {
        let body = LlmIdeAPIClient.loopAgentRunRequest(
            message: "m", skills: [], repoRoot: URL(fileURLWithPath: "/tmp/p/code/app"),
            extraRoots: [URL(fileURLWithPath: "/tmp/p/llm-doc")], language: nil, model: nil, timeout: nil)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(json["extraRoots"] as? [String], ["/tmp/p/llm-doc"])
        let bare = LlmIdeAPIClient.loopAgentRunRequest(
            message: "m", skills: [], repoRoot: URL(fileURLWithPath: "/tmp/r"), language: nil, model: nil, timeout: nil)
        let bareJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(bare)) as? [String: Any])
        XCTAssertNil(bareJSON["extraRoots"])
    }

    // MARK: - P1: a skill run that did nothing it was asked to FAILS

    private func runSkill(returning result: LoopAgentResult,
                          guardChanged: [String] = []) async -> (LoopEngineStatus?, LoopStageAttempt?) {
        let skills = SkillExecutor()
        skills.result = result
        let journal = Journal()
        let scope = CancellationSensitiveGuard(violation: [])
        let r = runner(skills: skills, approvals: approvals([]), journal: journal, scopeGuard: scope)
        let status = await r.run(config: skillConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)
        return (status, journal.written.last?.iterations.last?.attempts.last)
    }

    func testSkillStageFailsWhenTheRunDidNotFinish() async {
        let (status, attempt) = await runSkill(returning: LoopAgentResult(resultSubtype: "error_max_turns"))
        guard case .error(let message)? = status else { return XCTFail("expected .error, got \(String(describing: status))") }
        XCTAssertTrue(message.contains("error_max_turns"), message)
        XCTAssertEqual(attempt?.passed, false)
        XCTAssertEqual(attempt?.agentNote, "agent run ended error_max_turns")
    }

    func testSkillStageFailsWhenItsSkillWasTruncated() async {
        let (status, attempt) = await runSkill(returning: LoopAgentResult(
            changedPaths: ["a.md"], resolvedSkills: ["fam/plan"], truncatedSkills: ["fam/plan"]))
        guard case .error(let message)? = status else { return XCTFail("expected .error") }
        XCTAssertTrue(message.contains("fam/plan"), message)
        XCTAssertEqual(attempt?.passed, false)
    }

    func testSkillStageFailsWhenEveryEditWasRefusedAndNothingChanged() async {
        let denial = LoopAgentResult.Denial(toolName: "Write", reason: "Write refused: /p/llm-doc/PLAN.md is outside")
        let (status, _) = await runSkill(returning: LoopAgentResult(denied: [denial]))
        guard case .error(let message)? = status else { return XCTFail("expected .error") }
        XCTAssertTrue(message.contains("PLAN.md is outside"), "names the first denial: \(message)")
    }

    func testSkillStageWithDenialsButRealEditsStillPasses() async {
        let denial = LoopAgentResult.Denial(toolName: "Read", reason: "Read refused: .env")
        let (status, attempt) = await runSkill(returning: LoopAgentResult(
            changedExtraPaths: ["/p/llm-doc/plans/PLAN.md"], denied: [denial]))
        XCTAssertEqual(status, .success)
        XCTAssertEqual(attempt?.passed, true)
    }

    func testRepairDenialsAndSubtypeAreRecordedButDoNotFailTheStage() async {
        var runs = 0
        let verifier = Verifier { _ in
            runs += 1
            return VerifyOutcome(exitCode: runs <= 2 ? 1 : 0, output: runs <= 2 ? "1 failure" : "")
        }
        let repairer = Repairer()
        repairer.body = {
            LoopAgentResult(resultSubtype: "error_max_turns",
                            denied: [.init(toolName: "Bash", reason: "Bash is not available")])
        }
        let journal = Journal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 3)
        let r = runner(verifier: verifier, repairer: repairer, approvals: approvals([("t", "swift test")]),
                       journal: journal, scopeGuard: CancellationSensitiveGuard(violation: []))
        let status = await r.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(status, .success, "the verify re-run decides, not the repair's ending")
        let repairAttempt = journal.written.last?.iterations.first?.attempts.first(where: { $0.repairAttempted })
        XCTAssertEqual(repairAttempt?.repairAttempted, true)
        XCTAssertEqual(repairAttempt?.agentNote,
                       "agent run ended error_max_turns; 1 tool call(s) refused, first: Bash is not available")
    }

    // MARK: - P9: agent calls are bounded by the stage timeout and the budget

    func testRepairTimeoutIsTheStageTimeoutWhenNoBudget() async {
        var runs = 0
        let repairer = Repairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0,
                      timeoutSeconds: 50)
        ], maxIterations: 3, consecutiveFailureStop: 3)
        let r = runner(verifier: Verifier { _ in runs += 1; return VerifyOutcome(exitCode: runs <= 2 ? 1 : 0, output: "x") },
                       repairer: repairer, approvals: approvals([("t", "swift test")]),
                       scopeGuard: CancellationSensitiveGuard(violation: []))
        _ = await r.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(repairer.timeouts, [50])
    }

    func testRepairTimeoutIsCappedByTheRemainingBudget() async {
        var runs = 0
        let repairer = Repairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0,
                      timeoutSeconds: 5_000)
        ], maxIterations: 3, consecutiveFailureStop: 3, wallClockBudgetSeconds: 30)
        let r = runner(verifier: Verifier { _ in runs += 1; return VerifyOutcome(exitCode: runs <= 2 ? 1 : 0, output: "x") },
                       repairer: repairer, approvals: approvals([("t", "swift test")]),
                       scopeGuard: CancellationSensitiveGuard(violation: []))
        _ = await r.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        let timeout = try? XCTUnwrap(repairer.timeouts.first ?? nil)
        XCTAssertNotNil(timeout)
        XCTAssertLessThanOrEqual(timeout ?? .infinity, 30)
        XCTAssertGreaterThan(timeout ?? 0, 25)
    }

    func testSkillTimeoutIsNilWithNeitherStageTimeoutNorBudget() async {
        let skills = SkillExecutor()
        let r = runner(skills: skills, approvals: approvals([]), stageTimeout: 0,
                       scopeGuard: CancellationSensitiveGuard(violation: []))
        _ = await r.run(config: skillConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(skills.timeouts.count, 1)
        XCTAssertNil(skills.timeouts.first ?? nil, "nil → the server's default budget")
    }

    // MARK: - P4: the agent's own changedPaths reach the guard

    func testIgnoredProtectedWriteReportedByTheAgentIsSeenAndReverted() async {
        var runs = 0
        let repairer = Repairer()
        repairer.body = {
            // git status cannot see these (ignored); only the server's list can.
            LoopAgentResult(changedPaths: ["tests/fixtures/expected.json", "src/app.swift"],
                            createdPaths: ["tests/fixtures/expected.json"])
        }
        let scope = CancellationSensitiveGuard(violation: [])
        let journal = Journal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 3, protectedPathPolicy: .revert)
        let r = runner(verifier: Verifier { _ in runs += 1; return VerifyOutcome(exitCode: runs <= 2 ? 1 : 0, output: "x") },
                       repairer: repairer, approvals: approvals([("t", "swift test")]),
                       journal: journal, scopeGuard: scope)
        let status = await r.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)

        guard case .blocked? = status else { return XCTFail("expected .blocked, got \(String(describing: status))") }
        XCTAssertEqual(scope.revertedUnlisted, ["tests/fixtures/expected.json"])
        XCTAssertEqual(scope.unlistedCreated, ["tests/fixtures/expected.json"])
        XCTAssertEqual(scope.reverted, [], "nothing git listed needed reverting")
        let attempt = journal.written.last?.iterations.first?.attempts.first(where: { $0.repairAttempted })
        XCTAssertEqual(attempt?.changedPaths, ["src/app.swift", "tests/fixtures/expected.json"])
        XCTAssertEqual(attempt?.scopeVerdict, .violatedReverted)
    }

    func testReportedWriteOfAnUnprotectedPathStaysClean() async {
        var runs = 0
        let repairer = Repairer()
        repairer.body = { LoopAgentResult(changedPaths: ["build/cache.txt"]) }
        let journal = Journal()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 3, protectedPathPolicy: .revert)
        let r = runner(verifier: Verifier { _ in runs += 1; return VerifyOutcome(exitCode: runs <= 2 ? 1 : 0, output: "x") },
                       repairer: repairer, approvals: approvals([("t", "swift test")]),
                       journal: journal, scopeGuard: CancellationSensitiveGuard(violation: []))
        let status = await r.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(status, .success)
        XCTAssertEqual(journal.written.last?.iterations.first?.attempts.first(where: { $0.repairAttempted })?.changedPaths, ["build/cache.txt"])
    }

    // Real git: restore a tracked ignored file from HEAD, delete a created one,
    // and never delete an ignored file that was there before the edit.
    func testGitRevertUnlistedRestoresTrackedDeletesCreatedKeepsPreexisting() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("p1fix-unlisted-\(UUID().uuidString)", isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("gen"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        try "gen/\n".write(to: root.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
        try "v1\n".write(to: root.appendingPathComponent("gen/tracked.txt"), atomically: true, encoding: .utf8)
        func git(_ args: String...) throws {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = ["-C", root.path] + args
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try p.run(); p.waitUntilExit()
            XCTAssertEqual(p.terminationStatus, 0, "git \(args)")
        }
        try git("init", "-q")
        try git("add", ".gitignore")
        try git("add", "-f", "gen/tracked.txt")
        try git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init")
        try "local\n".write(to: root.appendingPathComponent("gen/preexisting.txt"), atomically: true, encoding: .utf8)
        // The agent's edits:
        try "rigged\n".write(to: root.appendingPathComponent("gen/tracked.txt"), atomically: true, encoding: .utf8)
        try "new\n".write(to: root.appendingPathComponent("gen/created.txt"), atomically: true, encoding: .utf8)
        try "rigged\n".write(to: root.appendingPathComponent("gen/preexisting.txt"), atomically: true, encoding: .utf8)

        let error = await GitRepairScopeGuard().revertUnlisted(
            paths: ["gen/tracked.txt", "gen/created.txt", "gen/preexisting.txt"],
            created: ["gen/created.txt"], gitRoot: root)

        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("gen/tracked.txt"), encoding: .utf8), "v1\n")
        XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("gen/created.txt").path))
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("gen/preexisting.txt").path),
                      "a file that existed before the edit is never deleted")
        XCTAssertTrue(error?.contains("gen/preexisting.txt") == true, String(describing: error))
    }

    // MARK: - P6: the run's main git root is registered before any agent call

    final class Registrar: LoopRepoRegistering {
        var error: Error?
        private(set) var registered: [URL] = []
        func register(repoRoot: URL) async throws {
            registered.append(repoRoot)
            if let error { throw error }
        }
    }

    func testMainGitRootIsRegisteredOnceBeforeTheFirstAgentCall() async {
        var runs = 0
        let registrar = Registrar()
        let skills = SkillExecutor()
        let repairer = Repairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "plan", name: "Plan", kind: .skill, order: 0, skillId: "fam/plan"),
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 3, consecutiveFailureStop: 3)
        let r = runner(verifier: Verifier { _ in runs += 1; return VerifyOutcome(exitCode: runs <= 2 ? 1 : 0, output: "x") },
                       repairer: repairer, skills: skills, approvals: approvals([("t", "swift test")]),
                       registrar: registrar, scopeGuard: CancellationSensitiveGuard(violation: []))
        let status = await r.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(status, .success)
        XCTAssertEqual(registrar.registered, [repoRoot], "once per run, the main git root")
        XCTAssertEqual(repairer.calls, 1)
        XCTAssertEqual(skills.calls, 2, "the retry iteration re-runs the skill")
    }

    func testRegistrationFailureFailsTheStageWithoutCallingTheAgent() async {
        struct Down: LocalizedError { var errorDescription: String? { "HTTP 500" } }
        let registrar = Registrar()
        registrar.error = Down()
        let skills = SkillExecutor()
        let r = runner(skills: skills, approvals: approvals([]), registrar: registrar,
                       scopeGuard: CancellationSensitiveGuard(violation: []))
        let status = await r.run(config: skillConfig(), faultsRoot: repoRoot, gitRoot: repoRoot)
        guard case .error(let message)? = status else { return XCTFail("expected .error") }
        XCTAssertTrue(message.contains("repo \(repoRoot.path) is not registered with the server"), message)
        XCTAssertEqual(skills.calls, 0)
    }

    // MARK: - Follow-up: too-broad roots, late writes, hidden tracked files

    func testTooBroadRootRule() {
        XCTAssertTrue(LoopRepoRoot.isTooBroad(URL(fileURLWithPath: "/")))
        XCTAssertTrue(LoopRepoRoot.isTooBroad(URL(fileURLWithPath: NSHomeDirectory())))
        XCTAssertTrue(LoopRepoRoot.isTooBroad(URL(fileURLWithPath: "/Users")))
        XCTAssertTrue(LoopRepoRoot.isTooBroad(URL(fileURLWithPath: "/usr/local")))
        XCTAssertFalse(LoopRepoRoot.isTooBroad(URL(fileURLWithPath: NSHomeDirectory() + "/code/app")))
        XCTAssertFalse(LoopRepoRoot.isTooBroad(URL(fileURLWithPath: "/tmp/some/repo")))
    }

    func testTooBroadRootFailsTheStageAndSkipsRegistration() async {
        let registrar = Registrar()
        let skills = SkillExecutor()
        let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        let r = runner(skills: skills, approvals: approvals([]), registrar: registrar,
                       scopeGuard: CancellationSensitiveGuard(violation: []))
        let status = await r.run(config: skillConfig(), faultsRoot: repoRoot, gitRoot: home)
        guard case .error(let message)? = status else { return XCTFail("expected .error, got \(String(describing: status))") }
        XCTAssertTrue(message.contains("is too broad for a Loop agent (e.g. your home folder)"), message)
        XCTAssertEqual(registrar.registered, [], "never sent to the server")
        XCTAssertEqual(skills.calls, 0)
    }

    func testSweepGuardRegistersTheRepoBeforeTheRepairAndRefusesABroadOne() async throws {
        let registrar = Registrar()
        let scope = CancellationSensitiveGuard(violation: [])
        let repairGuard = ProtectedPathRepairGuard.make(scopeGuard: scope, registrar: registrar)
        var order: [String] = []
        let root = URL(fileURLWithPath: "/tmp/r")
        _ = try await repairGuard(root) { _ in order.append("repair:\(registrar.registered.count)"); return LoopAgentResult() }
        XCTAssertEqual(registrar.registered, [root])
        XCTAssertEqual(order, ["repair:1"], "registered before the repair ran")

        var ran = false
        do {
            _ = try await repairGuard(URL(fileURLWithPath: NSHomeDirectory())) { _ in ran = true; return LoopAgentResult() }
            XCTFail("expected a too-broad refusal")
        } catch { XCTAssertTrue(error is LoopRepoRoot.TooBroadError) }
        XCTAssertFalse(ran)
        XCTAssertEqual(registrar.registered.count, 1)
    }

    /// Reports clean on the first check and a violation on the next: the write
    /// lands just after the client aborted.
    final class LateWriteGuard: RepairScopeGuarding {
        private(set) var checks = 0
        private(set) var reverted: [String] = []
        func snapshot(gitRoot: URL, protectedGlobs: [String], scopeGlobs: [String]) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck {
            checks += 1
            return checks == 1 ? .clean(changedPaths: [])
                : .violated(paths: ["Tests/LateTests.swift"], allChangedPaths: ["Tests/LateTests.swift"])
        }
        func revert(paths: [String], gitRoot: URL) async -> String? { reverted += paths; return nil }
    }

    func testAWriteLandingJustAfterTheAbortIsStillCaught() async {
        let started = expectation(description: "repair started")
        let repairer = Repairer()
        repairer.body = {
            started.fulfill()
            try await Task.sleep(nanoseconds: 30_000_000_000)
            return LoopAgentResult()
        }
        let scope = LateWriteGuard()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 3, protectedPathPolicy: .revert)
        let r = runner(verifier: Verifier { _ in VerifyOutcome(exitCode: 1, output: "1 failure") },
                       repairer: repairer, approvals: approvals([("t", "swift test")]),
                       journal: Journal(), scopeGuard: scope)
        r.postThrowRecheckNanos = 20_000_000
        let root = repoRoot
        let task = Task { await r.run(config: config, faultsRoot: root, gitRoot: root) }
        await fulfillment(of: [started], timeout: 10)
        task.cancel()
        _ = await task.value
        XCTAssertEqual(scope.checks, 2, "re-checked after the pause")
        XCTAssertEqual(scope.reverted, ["Tests/LateTests.swift"])
    }

    // Real git: an assume-unchanged file whose local content differs from HEAD
    // is the user's own edit — never overwritten; one equal to HEAD is restored.
    func testRevertUnlistedNeverClobbersAHiddenLocalEdit() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("p1fix-hidden-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: root.appendingPathComponent("tests"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        func git(_ args: String...) throws {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = ["-C", root.path] + args
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try p.run(); p.waitUntilExit()
            XCTAssertEqual(p.terminationStatus, 0, "git \(args)")
        }
        func write(_ name: String, _ text: String) throws {
            try text.write(to: root.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        try write("tests/mine.txt", "v1\n")
        try write("tests/same.txt", "v1\n")
        try git("init", "-q")
        try git("add", ".")
        try git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init")
        try git("update-index", "--assume-unchanged", "tests/mine.txt", "tests/same.txt")
        try write("tests/mine.txt", "my local edit\n")   // invisible to git status

        let guardUnderTest = GitRepairScopeGuard()
        let before = await guardUnderTest.snapshot(gitRoot: root)
        XCTAssertEqual(Set(before.hiddenHashes.keys), ["tests/mine.txt", "tests/same.txt"])
        try write("tests/mine.txt", "rigged\n")
        try write("tests/same.txt", "rigged\n")

        let error = await guardUnderTest.revertUnlisted(
            paths: ["tests/mine.txt", "tests/same.txt"], created: [], before: before, gitRoot: root)

        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("tests/mine.txt"), encoding: .utf8),
                       "rigged\n", "left in place: HEAD's blob is not the user's pre-edit content")
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("tests/same.txt"), encoding: .utf8),
                       "v1\n", "pre-edit content equalled HEAD, so it is restored")
        XCTAssertTrue(error?.contains("tests/mine.txt") == true, String(describing: error))
        XCTAssertFalse(error?.contains("tests/same.txt") == true)
    }
}

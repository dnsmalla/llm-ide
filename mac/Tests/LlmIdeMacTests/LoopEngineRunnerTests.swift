import XCTest
@testable import LlmIdeMacLib

@MainActor
final class LoopEngineRunnerTests: XCTestCase {
    private final class StubVerifier: FaultVerifier {
        var outcomes: [VerifyOutcome]
        private(set) var callCount = 0
        init(outcomes: [VerifyOutcome]) { self.outcomes = outcomes }
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            defer { callCount += 1 }
            return outcomes[min(callCount, outcomes.count - 1)]
        }
    }

    private final class StubRepairer: LoopStageRepairer {
        private(set) var repairCount = 0
        func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws {
            repairCount += 1
        }
    }

    private final class StubRegressionSweep: RegressionSweepRunning {
        var alwaysPasses: Bool
        init(alwaysPasses: Bool) { self.alwaysPasses = alwaysPasses }
        func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool { alwaysPasses }
    }

    private func makeApprovals(approve stages: [(stageId: String, command: String)] = []) -> VerifyApprovalStore {
        let suite = UserDefaults(suiteName: "loop-engine-runner-test-\(UUID().uuidString)")!
        let store = VerifyApprovalStore(defaults: suite)
        for (stageId, command) in stages {
            store.approveStage(repo: URL(fileURLWithPath: "/tmp/repo"), stageId: stageId, command: command)
        }
        return store
    }

    private let repoRoot = URL(fileURLWithPath: "/tmp/repo")

    func testAllStagesPassOnFirstIterationSucceeds() async {
        let verifier = StubVerifier(outcomes: [VerifyOutcome(exitCode: 0, output: "")])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .success)
        XCTAssertEqual(runner.iteration, 1)
        XCTAssertEqual(repairer.repairCount, 0)
    }

    func testOneFailureThenFixThenPassSucceedsOnSecondIteration() async {
        let verifier = StubVerifier(outcomes: [
            VerifyOutcome(exitCode: 1, output: "boom"),
            VerifyOutcome(exitCode: 0, output: "")
        ])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .success)
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 1)
    }

    func testMaxIterationsGivesUpWhenNeverFixed() async {
        let verifier = StubVerifier(outcomes: [VerifyOutcome(exitCode: 1, output: "still broken 1")])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 10)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 3)
    }

    func testConsecutiveIdenticalFailuresGivesUpBeforeMaxIterations() async {
        let verifier = StubVerifier(outcomes: [VerifyOutcome(exitCode: 1, output: "identical failure")])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .givenUp(reason: .repeatedFailure))
        XCTAssertEqual(runner.iteration, 2)
    }

    func testUnapprovedShellStageStopsImmediatelyWithoutRepairing() async {
        let verifier = StubVerifier(outcomes: [VerifyOutcome(exitCode: 0, output: "")])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals()   // nothing approved
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .needsApproval(stageName: "Test"))
        XCTAssertEqual(repairer.repairCount, 0)
    }

    func testFailingRegressionStageRetriesWithoutCallingStageRepairer() async {
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 2, consecutiveFailureStop: 5)
        let runner = LoopEngineRunner(
            verifier: StubVerifier(outcomes: [VerifyOutcome(exitCode: 0, output: "")]),
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            approvals: makeApprovals()
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 0)
    }
}

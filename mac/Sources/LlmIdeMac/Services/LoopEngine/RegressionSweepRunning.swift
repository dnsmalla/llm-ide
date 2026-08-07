import Foundation

/// Runs a Regression stage and reports pass/fail as a single boolean —
/// the seam `LoopEngineRunner` depends on instead of `RegressionRunner`
/// directly, so its own tests can fake this stage in isolation.
protocol RegressionSweepRunning {
    func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool
}

/// Production adapter wrapping the real `RegressionRunner`. A sweep
/// "passes" when no fault came back `.regressed`, `.repairFailed`, or
/// `.needsApproval` — `.unchanged` and `.repaired` both count as passing.
@MainActor
final class RegressionRunnerSweepAdapter: RegressionSweepRunning {
    private let runner: RegressionRunner

    init(runner: RegressionRunner) {
        self.runner = runner
    }

    func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool {
        await runner.run(faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: attemptRepair)
        return !runner.results.contains { result in
            switch result.verdict {
            case .regressed, .repairFailed, .needsApproval: return true
            default: return false
            }
        }
    }
}

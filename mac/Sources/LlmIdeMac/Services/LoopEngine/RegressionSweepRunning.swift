import Foundation

/// Runs a Regression stage and reports pass/fail as a single boolean —
/// the seam `LoopEngineRunner` depends on instead of `RegressionRunner`
/// directly, so its own tests can fake this stage in isolation.
protocol RegressionSweepRunning {
    func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool
}

/// Production adapter wrapping the real `RegressionRunner`. A sweep
/// "passes" when no fault came back `.regressed`, `.repairFailed`,
/// `.needsApproval`, or `.failed` — `.unchanged` and `.repaired` both
/// count as passing. `.failed` (a CLI/network error — the check
/// couldn't even run) is treated as not-passed rather than silently
/// ignored: fail-closed on ambiguity, matching `VerifyApprovalStore`'s
/// stance elsewhere in this codebase. Otherwise a transient
/// infrastructure hiccup would report as "regression sweep passed."
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
            case .regressed, .repairFailed, .needsApproval, .failed: return true
            default: return false
            }
        }
    }
}

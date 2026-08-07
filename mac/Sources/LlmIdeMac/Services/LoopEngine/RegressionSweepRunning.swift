import Foundation

/// Runs a Regression stage and reports pass/fail as a single boolean —
/// the seam `LoopEngineRunner` depends on instead of `RegressionRunner`
/// directly, so its own tests can fake this stage in isolation.
protocol RegressionSweepRunning {
    func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool
}

/// Production adapter wrapping the real `RegressionRunner`. A sweep
/// "passes" when no fault came back `.regressed`, `.repairFailed`,
/// `.needsApproval`, `.failed`, or `.pending` — `.unchanged` and
/// `.repaired` both count as passing. `.failed` (a CLI/network error —
/// the check couldn't even run) and `.pending` (a fault never reached
/// during a cancelled sweep) are both treated as not-passed rather
/// than silently ignored: fail-closed on ambiguity, matching
/// `VerifyApprovalStore`'s stance elsewhere in this codebase. The
/// verdict switch below is intentionally exhaustive (no `default:`)
/// so a future `Verdict` case can't silently fall into "not failing."
///
/// Owns `runner` exclusively: callers must hand this adapter a
/// dedicated `RegressionRunner` it alone drives. Passing in a runner
/// another caller might concurrently invoke `run()` on is unsupported
/// — `sweepPassed` guards against re-entrancy on this instance but a
/// runner shared across two adapters/callers is still a hazard, since
/// `RegressionRunner.run()` no-ops (leaving stale `results`) when it's
/// already running.
@MainActor
final class RegressionRunnerSweepAdapter: RegressionSweepRunning {
    private let runner: RegressionRunner

    init(runner: RegressionRunner) {
        self.runner = runner
    }

    func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool {
        // `RegressionRunner.run()` guards re-entrancy by no-op-returning
        // without resetting `results` — reading that stale/partial state
        // would silently report a pass. Refuse instead.
        guard !runner.running else { return false }
        await runner.run(faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: attemptRepair)
        return !runner.results.contains { result in
            switch result.verdict {
            case .pending, .regressed, .repairFailed, .needsApproval, .failed: return true
            case .unchanged, .repaired: return false
            }
        }
    }
}

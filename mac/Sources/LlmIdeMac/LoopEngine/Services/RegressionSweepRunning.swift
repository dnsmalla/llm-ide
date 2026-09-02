import Foundation

/// Per-sweep outcome: a pass/fail verdict plus the verdict-count breakdown
/// the runner needs to (a) log human-readable progress and (b) detect a
/// stall (regressed count not shrinking across iterations). The seam
/// `LoopEngineRunner` depends on instead of `RegressionRunner` directly,
/// so its own tests can fake this stage in isolation.
struct SweepOutcome: Equatable {
    let passed: Bool
    let total: Int
    let regressed: Int
    let unchanged: Int
    let repaired: Int
    let repairFailed: Int
    let needsApproval: Int
    let failed: Int
    let pending: Int
}

protocol RegressionSweepRunning {
    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> SweepOutcome
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
/// — `sweep` guards against re-entrancy on this instance but a runner
/// shared across two adapters/callers is still a hazard, since
/// `RegressionRunner.run()` no-ops (leaving stale `results`) when it's
/// already running.
@MainActor
final class RegressionRunnerSweepAdapter: RegressionSweepRunning {
    private let runner: RegressionRunner

    init(runner: RegressionRunner) {
        self.runner = runner
    }

    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> SweepOutcome {
        // `RegressionRunner.run()` guards re-entrancy by no-op-returning
        // without resetting `results` — reading that stale/partial state
        // would silently report a pass. Refuse instead (fail-closed).
        guard !runner.running else {
            return SweepOutcome(passed: false, total: 0, regressed: 0, unchanged: 0,
                                 repaired: 0, repairFailed: 0, needsApproval: 0,
                                 failed: 0, pending: 0)
        }
        await runner.run(faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: attemptRepair)

        var regressed = 0, unchanged = 0, repaired = 0
        var repairFailed = 0, needsApproval = 0, failed = 0, pending = 0
        for result in runner.results {
            switch result.verdict {
            case .pending:        pending += 1
            case .unchanged:      unchanged += 1
            case .regressed:      regressed += 1
            case .repaired:       repaired += 1
            case .repairFailed:   repairFailed += 1
            case .needsApproval:  needsApproval += 1
            case .failed:         failed += 1
            }
        }
        let nonPassing = regressed + repairFailed + needsApproval + failed + pending
        return SweepOutcome(passed: nonPassing == 0,
                            total: runner.results.count,
                            regressed: regressed, unchanged: unchanged, repaired: repaired,
                            repairFailed: repairFailed, needsApproval: needsApproval,
                            failed: failed, pending: pending)
    }
}

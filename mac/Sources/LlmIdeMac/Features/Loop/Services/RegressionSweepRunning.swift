import Foundation

/// The seam `LoopEngineRunner` depends on instead of `RegressionRunner`
/// directly, so its own tests can fake this stage in isolation. Its result,
/// `SweepOutcome`, lives in Core/Contracts.
protocol RegressionSweepRunning {
    /// `repairGuard` wraps each fault repair the sweep makes — the Loop passes
    /// its protected-path guard so the sweep's own repairs are checked like
    /// every other agent edit.
    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
               repairGuard: FaultRepairGuard?) async -> SweepOutcome

    /// Same, bounded by the enclosing run's time budget: verify timeouts are
    /// clamped to `deadline`, and past it no fault is checked or repaired.
    /// Default: ignores the deadline (implementations that cannot honour it).
    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
               repairGuard: FaultRepairGuard?, deadline: Date?) async -> SweepOutcome

    /// The model the sweep's fault repairs run on (`nil` = app default).
    func setRepairModel(_ model: String?)
}

extension RegressionSweepRunning {
    func setRepairModel(_ model: String?) {}

    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
               repairGuard: FaultRepairGuard?, deadline: Date?) async -> SweepOutcome {
        await sweep(faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: attemptRepair,
                    repairGuard: repairGuard)
    }

    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> SweepOutcome {
        await sweep(faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: attemptRepair,
                    repairGuard: nil)
    }
}

extension SweepOutcome {
    /// Counts a finished sweep's verdicts. Shared by the Loop's
    /// `RegressionRunnerSweepAdapter` and the standalone Regression auto-task
    /// (`LoopRunnerProvider.runRegressionSweep`), so both classify verdicts
    /// the same way. The switch is exhaustive (no `default:`) so a future
    /// `Verdict` case can't silently fall into "passing".
    static func tally(_ verdicts: [RegressionRunner.Verdict]) -> SweepOutcome {
        var regressed = 0, unchanged = 0, repaired = 0
        var repairFailed = 0, needsApproval = 0, failed = 0, pending = 0
        for verdict in verdicts {
            switch verdict {
            case .pending:        pending += 1
            case .unchanged:      unchanged += 1
            // A skipped repair leaves the fault regressed (the Loop always
            // passes a guard, so it never sees one).
            case .regressed, .repairSkipped: regressed += 1
            case .repaired:       repaired += 1
            case .repairFailed:   repairFailed += 1
            case .needsApproval:  needsApproval += 1
            case .failed:         failed += 1
            }
        }
        let nonPassing = regressed + repairFailed + needsApproval + failed + pending
        return SweepOutcome(passed: nonPassing == 0,
                            total: verdicts.count,
                            regressed: regressed, unchanged: unchanged, repaired: repaired,
                            repairFailed: repairFailed, needsApproval: needsApproval,
                            failed: failed, pending: pending)
    }
}

/// Production adapter wrapping the real `RegressionRunner`. A sweep
/// "passes" when no fault came back `.regressed`, `.repairFailed`,
/// `.needsApproval`, `.failed`, or `.pending` — `.unchanged` and
/// `.repaired` both count as passing. `.failed` (a CLI/network error —
/// the check couldn't even run) and `.pending` (a fault never reached
/// during a cancelled sweep) are both treated as not-passed rather
/// than silently ignored: fail-closed on ambiguity, matching
/// `VerifyApprovalStore`'s stance elsewhere in this codebase. The
/// verdict switch (`SweepOutcome.tally`) is intentionally exhaustive (no
/// `default:`) so a future `Verdict` case can't silently fall into "not failing."
///
/// Owns `runner` exclusively: callers must hand this adapter a
/// dedicated `RegressionRunner` it alone drives. Passing in a runner
/// another caller might concurrently invoke `run()` on is unsupported
/// — `sweep` guards against re-entrancy on this instance but a runner
/// shared across two adapters/callers is still a hazard, since
/// `RegressionRunner.run()` no-ops (leaving stale `results`) when it's
/// already running.
///
/// `@preconcurrency` conformance: `RegressionRunner` is main-actor state and
/// every use site (`LoopEngineRunner`) is itself `@MainActor`, so the witness
/// runs with a runtime main-actor check instead of a compile-time crossing.
/// Not the SE-0470 isolated conformance (`: @MainActor RegressionSweepRunning`):
/// that spelling is Swift 6.2-only and CI / other machines may run 6.0-6.1.
@MainActor
final class RegressionRunnerSweepAdapter: @preconcurrency RegressionSweepRunning {
    private let runner: RegressionRunner

    init(runner: RegressionRunner) {
        self.runner = runner
    }

    func setRepairModel(_ model: String?) { runner.repairModel = model }

    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
               repairGuard: FaultRepairGuard?) async -> SweepOutcome {
        await sweep(faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: attemptRepair,
                    repairGuard: repairGuard, deadline: nil)
    }

    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool,
               repairGuard: FaultRepairGuard?, deadline: Date?) async -> SweepOutcome {
        // `RegressionRunner.run()` guards re-entrancy by no-op-returning
        // without resetting `results` — reading that stale/partial state
        // would silently report a pass. Refuse instead (fail-closed).
        guard !runner.running else {
            return SweepOutcome(passed: false, total: 0, regressed: 0, unchanged: 0,
                                 repaired: 0, repairFailed: 0, needsApproval: 0,
                                 failed: 0, pending: 0)
        }
        await runner.run(faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: attemptRepair,
                         repairGuard: repairGuard, deadline: deadline)

        return SweepOutcome.tally(runner.results.map(\.verdict))
    }
}

import Foundation

/// Per-sweep outcome: a pass/fail verdict plus the verdict-count breakdown
/// the runner needs to (a) log human-readable progress and (b) detect a
/// stall (regressed count not shrinking across iterations). Returned by
/// Loop's `RegressionSweepRunning` seam.
///
/// In Core (not Loop) because AutoTask's standalone Regression task reads it
/// back from `LoopRunnerProviding.runRegressionSweep` — the regression runner
/// itself is Loop's and is compiled out with `auto_tasks`.
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

extension SweepOutcome {
    /// Faults that make the sweep fail: everything that is not `.unchanged`
    /// or `.repaired`. The regression stage's progress score — `regressed`
    /// alone is always 0 once repair is attempted (a repaired-or-not fault is
    /// `.repaired` / `.repairFailed`, never `.regressed`), so it could never
    /// show progress or a stall.
    var failingCount: Int { max(0, total - (unchanged + repaired)) }
}

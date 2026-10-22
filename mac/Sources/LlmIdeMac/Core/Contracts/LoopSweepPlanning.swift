import Foundation

/// One loop a Loop Engineering sweep will run, as AutoTask's scheduler sees it.
///
/// The scheduler only needs a name, stage counts for its log lines, a way to
/// re-check the loop right before it runs, and a way to run it. Everything
/// else — `LoopDefinition`, its `LoopEngineConfig`, goal, scope globs — stays
/// inside Loop, captured by the two closures, so this Core type names no
/// Loop-owned model (the check-7 "Core is a leaf" rule).
struct LoopSweepTarget {
    let id: String
    let name: String
    /// All stages in the loop, enabled or not.
    let stageCount: Int
    /// Stages the runner will actually execute (it skips disabled ones).
    let enabledStageCount: Int
    /// Re-reads the loop from disk just before it runs: the sweep takes its
    /// list once and may then run for hours, in which time the loop can be
    /// deleted, unscheduled or emptied. `target == nil` means skip, with
    /// `skipReason` saying why.
    let recheck: @MainActor () -> LoopSweepRecheck
    /// Runs this loop on `runner` with its own config, goal and scope. Same
    /// return contract as `LoopRunning.run`: nil means the run was rejected
    /// (runner busy, or cancelled while queued).
    let run: @MainActor (LoopRunning) async -> LoopEngineStatus?
}

/// Result of `LoopSweepTarget.recheck`.
struct LoopSweepRecheck {
    let target: LoopSweepTarget?
    let skipReason: String?
}

/// What a sweep should run, decided by Loop from the project's saved loops.
enum LoopSweepPlan {
    /// Run these loops, in order. Never empty — an empty selection is `.parked`.
    case run([LoopSweepTarget])
    /// Nothing to run: the project parked every loop on purpose (none
    /// scheduled, or none with an enabled stage). `hasLoops` is false when the
    /// project has no loops configured at all.
    case parked(hasLoops: Bool)
    /// `onlyStageId` matched no stage in any loop.
    case unknownStage
    /// `onlyLoopId` matched no loop, or that loop has no enabled stage.
    case unknownLoop
}

/// How AutoTask's Loop Engineering sweep picks loops and reports completion
/// without naming `LoopEngineConfigStore`, `LoopDefinition`, `LoopStage` or
/// `LoopRunNotifier`. Loop implements it (`LoopSweepPlanner`); Shell injects
/// it into `AutoCodeUpdateService`. Running a picked loop still goes through
/// `LoopRunnerProviding` / `LoopRunning`.
@MainActor
protocol LoopSweepPlanning: AnyObject {
    /// Loads (creating / migrating / persisting when safe) the project's loops
    /// and selects the sweep's targets.
    /// - Parameters:
    ///   - onlyStageId: run just the loop owning this stage, with only that
    ///     stage enabled for this run (the saved config is untouched).
    ///   - onlyLoopId: run just this loop, ignoring its schedule flag.
    ///   Neither set: every scheduled loop with an enabled stage.
    func planSweep(projectRoot: URL, projectId: String, gitRoot: URL, defaults: UserDefaults,
                   onlyStageId: String?, onlyLoopId: String?) -> LoopSweepPlan

    /// Posts the same background-only banner desktop Loop runs get.
    func notifySweepFinished(title: String, body: String)
}

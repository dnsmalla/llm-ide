import Foundation

/// One line of Loop run output, mirrored to any observer via `LoopRunning.onLog`.
///
/// Promoted out of `LoopEngineRunner` (was a nested `LoopEngineRunner.LogLine`)
/// because AutoTask's scheduler must be able to name this type in `LoopRunning`
/// without naming `LoopEngineRunner` or any of its collaborators.
struct LoopLogLine: Identifiable, Equatable {
    enum Level: Equatable { case info, warn, error }
    let id = UUID()
    let at: Date
    let level: Level
    let text: String
}

/// What a Loop run exposes to a scheduler. AutoTask drives Loop through this
/// and never names `LoopEngineRunner` or its collaborators
/// (`AgentLoopStageRepairer`, `AgentLoopSkillExecutor`,
/// `RegressionRunnerSweepAdapter`) — those are Loop's internals and changing
/// them must not break the scheduler.
@MainActor
protocol LoopRunning: AnyObject {
    /// Iterations completed so far. Read after `run` returns for reporting.
    var iteration: Int { get }
    /// Called for every log line as it happens, so the scheduler can mirror
    /// the run into its own per-task log buffer.
    var onLog: ((LoopLogLine) -> Void)? { get set }

    #if FEATURE_AUTOTASK
    /// Returns nil when the call was REJECTED because a run is already in
    /// progress for this repo. Callers must branch on the return value, not
    /// on any status property — see `LoopEngineRunner.status`'s doc comment.
    ///
    /// `config: LoopEngineConfig` is the one place this requirement names a
    /// Loop-owned concrete type, which is why the whole requirement is
    /// guarded by `#if FEATURE_AUTOTASK` — the single flag that excludes
    /// `Features/Loop` and `Features/AutoTask` together (see Package.swift).
    /// This file lives in Core, which is always linked, so it must still
    /// compile in a build that drops `LoopEngineConfig` entirely; nothing
    /// outside that shared build combination can call this method anyway,
    /// since only AutoTask (excluded in lockstep with Loop) calls it.
    func run(config: LoopEngineConfig,
             faultsRoot: URL,
             gitRoot: URL,
             projectId: String?,
             loopId: String,
             loopName: String,
             goal: String?,
             acceptanceCriteria: String?,
             scopeGlobs: [String]) async -> LoopEngineStatus?
    #endif
}

/// Loop registers one of these at boot; the scheduler asks it for a runner.
/// This is the half that removes the scheduler's knowledge of Loop's
/// collaborator types (`AgentLoopStageRepairer`, `AgentLoopSkillExecutor`,
/// `RegressionRunnerSweepAdapter`) — a bare `run()`-only protocol would not,
/// since the call site still needs to construct those collaborators itself.
///
/// `regressionVerifyTimeout` is a primitive, not `AutoTaskSettings` (the type
/// it actually lives on) — passing the concrete settings type would trade the
/// AutoTask→Loop reference this seam removes for a new Loop→AutoTask one.
@MainActor
protocol LoopRunnerProviding: AnyObject {
    func makeRunner(trigger: LoopRunTrigger, regressionVerifyTimeout: TimeInterval) -> LoopRunning
}

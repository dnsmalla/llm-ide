import Foundation

/// How a Loop Engineering run was started. Recorded on every journal entry
/// because the three triggers carry very different risk: a `.manual` run has a
/// human watching the log live, while an `.autoTask` run repairs code
/// unattended on a cron. Any later analysis of "which runs went wrong" is
/// meaningless without being able to separate them.
enum LoopRunTrigger: String, Codable {
    /// `LoopEngineView`'s Run button.
    case manual
    /// The Code Assistant chat's loop command.
    case chat
    /// `AutoCodeUpdateService`'s scheduled Loop Engineering sweep.
    case autoTask
}

/// Whether the edits a repair made stayed inside the code it was allowed to
/// touch. See `RepairScopeGuard` — a stage that only turned green because the
/// repair edited a protected path (a test, a build file, the harness's own
/// state) has not actually been fixed.
enum RepairScopeVerdict: String, Codable {
    /// No repair ran for this attempt, or the policy is `.off`.
    case notChecked
    /// A repair ran and touched no protected path.
    case clean
    /// The guard could not determine what changed (e.g. not a git working
    /// tree). Deliberately distinct from `.clean` so a journal reader is never
    /// misled into thinking the check passed when it merely could not run.
    case indeterminate
    /// A repair touched a protected path and the edit was left in place
    /// (policy `.warn` or `.stop`).
    case violated
    /// A repair touched a protected path and the offending paths were reverted
    /// (policy `.revert`).
    case violatedReverted
}

/// One execution of one stage within one iteration. The unit of "decision
/// observability" — every stage run pairs its inputs with the observable result
/// that drove the loop's next move.
struct LoopStageAttempt: Codable, Equatable {
    /// Cap on `outputTail`. Matches `AgentLoopStageRepairer.maxFailureOutputChars`
    /// so the journal records exactly what the repairer was shown, no more.
    /// That equivalence is a base case, not an absolute guarantee: when a
    /// loop's `goal`/`acceptanceCriteria` are set, the repairer additionally
    /// sees a prepended header that the journal does not record — see
    /// `LoopEngineRunner.prependGoalContext` — so `outputTail` stays the
    /// plain raw stage output while the repair prompt is header + trimmed tail.
    static let maxOutputTailChars = 4_000

    var stageId: String
    var stageName: String
    var kind: LoopStage.Kind
    var severity: LoopStageSeverity
    var startedAt: Date
    /// Wall-clock seconds the stage itself took (excludes any repair that followed).
    var durationSeconds: Double
    /// `nil` for `.regressionSweep` and `.skill`, which have no process exit code.
    var exitCode: Int32?
    var passed: Bool
    /// Last `maxOutputTailChars` of combined stdout+stderr (empty on a pass).
    var outputTail: String
    /// Normalized failure-output hash — the loop's fallback repeat detector.
    var outputHash: String?
    /// Parsed failing-test count when the runner's output was recognised
    /// (`StageOutputParser`); `nil` otherwise. The loop's primary progress signal.
    var score: Int?
    /// True when the loop asked the agent to repair this failure.
    var repairAttempted: Bool
    /// Repo-relative paths the repair changed, when the guard could enumerate them.
    var changedPaths: [String]
    var scopeVerdict: RepairScopeVerdict

    init(stageId: String, stageName: String, kind: LoopStage.Kind,
         severity: LoopStageSeverity, startedAt: Date, durationSeconds: Double,
         exitCode: Int32?, passed: Bool, outputTail: String, outputHash: String?,
         score: Int?, repairAttempted: Bool = false, changedPaths: [String] = [],
         scopeVerdict: RepairScopeVerdict = .notChecked) {
        self.stageId = stageId
        self.stageName = stageName
        self.kind = kind
        self.severity = severity
        self.startedAt = startedAt
        self.durationSeconds = durationSeconds
        self.exitCode = exitCode
        self.passed = passed
        self.outputTail = String(outputTail.suffix(Self.maxOutputTailChars))
        self.outputHash = outputHash
        self.score = score
        self.repairAttempted = repairAttempted
        self.changedPaths = changedPaths
        self.scopeVerdict = scopeVerdict
    }
}

/// One pass over the full ordered stage list.
struct LoopIterationRecord: Codable, Equatable {
    /// 1-based, matching the `iteration N/M` the run log prints.
    var index: Int
    var attempts: [LoopStageAttempt] = []
}

/// The config a run actually executed under, snapshotted at start. Without this
/// a journal entry is uninterpretable six weeks later: the stage list and its
/// budgets are user-editable, so "why did this give up at 3 iterations" can
/// only be answered against the config in force at the time.
struct LoopRunConfigSnapshot: Codable, Equatable {
    struct Stage: Codable, Equatable {
        var id: String
        var name: String
        var kind: LoopStage.Kind
        var command: String?
        var skillId: String?
        var severity: LoopStageSeverity
        var timeoutSeconds: Int?
        /// Optional so records written before this field existed still decode.
        /// `nil` and `true` both mean "ran normally"; only `false` marks a
        /// stage the run deliberately skipped.
        var enabled: Bool?
    }

    var stages: [Stage]
    var maxIterations: Int
    var consecutiveFailureStop: Int
    var wallClockBudgetSeconds: Double?
    var maxRepairsPerStage: Int
    var protectedPathPolicy: ProtectedPathPolicy

    init(_ config: LoopEngineConfig) {
        stages = LoopStage.runOrder(config.stages)
            .map {
                Stage(id: $0.id, name: $0.name, kind: $0.kind, command: $0.command,
                      skillId: $0.skillId, severity: $0.severity,
                      timeoutSeconds: $0.timeoutSeconds, enabled: $0.enabled)
            }
        maxIterations = config.maxIterations
        consecutiveFailureStop = config.consecutiveFailureStop
        wallClockBudgetSeconds = config.wallClockBudgetSeconds
        maxRepairsPerStage = config.maxRepairsPerStage
        protectedPathPolicy = config.protectedPathPolicy
    }
}

/// The durable record of one Loop Engineering run.
///
/// `LoopEngineRunner`'s `@Published log` lives only as long as the app process,
/// so before this existed nothing survived a restart: how long stages took,
/// whether the failure count was shrinking, what the repair agent changed, and
/// whether a "success" was earned or reward-hacked were all unanswerable after
/// the fact. Persisting the trace to the file system (rather than keeping it in
/// memory or in an agent's context) is what makes the harness auditable and is
/// the prerequisite for any analysis across runs.
struct LoopRunRecord: Codable, Equatable {
    var id: String
    var projectId: String?
    var trigger: LoopRunTrigger
    var gitRoot: String
    var startedAt: Date
    var endedAt: Date
    var iterationsUsed: Int
    var config: LoopRunConfigSnapshot
    var iterations: [LoopIterationRecord]
    /// Stable machine-readable terminal status (`LoopEngineStatus.code`) — the
    /// key any cross-run analysis groups by. Kept separate from `statusSummary`
    /// so wording changes to the human string can never break that analysis.
    var statusCode: String
    /// Human-readable terminal status (`LoopEngineStatus.summary`).
    var statusSummary: String
    /// Which `LoopDefinition` this run executed, and its name at the time —
    /// `nil` for every record written before Loop Engineering supported more
    /// than one loop per project (treated as "the legacy/primary loop" by
    /// readers). Plain `Optional` properties decode missing keys as `nil`
    /// automatically — no custom `Decodable` needed, same as `projectId`.
    var loopId: String? = nil
    var loopName: String? = nil

    var durationSeconds: Double { endedAt.timeIntervalSince(startedAt) }
}

/// One line of `system/loop-runs/index.jsonl` — enough to render a run list
/// without opening every full record.
struct LoopRunIndexEntry: Codable, Equatable {
    var id: String
    var trigger: LoopRunTrigger
    var startedAt: Date
    var durationSeconds: Double
    var iterationsUsed: Int
    var statusCode: String
    var statusSummary: String
    var loopId: String? = nil
    var loopName: String? = nil

    init(_ record: LoopRunRecord) {
        id = record.id
        trigger = record.trigger
        startedAt = record.startedAt
        durationSeconds = record.durationSeconds
        iterationsUsed = record.iterationsUsed
        statusCode = record.statusCode
        statusSummary = record.statusSummary
        loopId = record.loopId
        loopName = record.loopName
    }
}

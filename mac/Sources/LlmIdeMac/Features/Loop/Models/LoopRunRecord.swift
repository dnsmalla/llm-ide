import Foundation

// LoopRunTrigger moved to Core/Contracts/LoopRunTrigger.swift — AutoTask's
// scheduler passes it into `LoopRunnerProviding.makeRunner(trigger:)` and must
// not need to import this file's other, Loop-internal journal types to do so.

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
    /// Wall-clock seconds the repair agent took, when one ran.
    ///
    /// This is the run's real cost signal. Per-request token counts and money
    /// are NOT obtainable on this path — the `/code-assist` response carries
    /// no usage block, and the default Claude CLI transport has no token data
    /// at all — so the honest measure of "what did this repair cost" is the
    /// time it took and how many attempts it needed. `nil` when no repair ran
    /// and on every record written before this field existed.
    var repairDurationSeconds: Double?
    /// Which repair this was for this stage in this run (1-based), against the
    /// `maxRepairsPerStage` budget in the config snapshot. Previously only the
    /// terminal `.repairBudgetExhausted` status hinted at repair spend, and
    /// only for the stage that ran out.
    var repairAttemptIndex: Int?
    /// Repo-relative paths the repair changed, when the guard could enumerate them.
    var changedPaths: [String]
    var scopeVerdict: RepairScopeVerdict
    /// True when the stage could not run at all — the agent call failed with a
    /// transport or backend error (after its one retry) — as opposed to running
    /// and failing. Optional so records written before this field existed still
    /// decode; `nil` and `false` both mean "not errored".
    var errored: Bool?
    /// What the agent run behind this attempt reported beyond its edits: a
    /// result subtype other than "success" (e.g. `error_max_turns`) and the
    /// tool calls the confinement refused. Optional so older records decode;
    /// `nil` means the run was clean (or no agent ran).
    var agentNote: String?
    /// The attempt-ledger entry for the repair this attempt ran (diff, reply,
    /// resulting failure set). Optional so older records decode.
    var ledger: LoopLedgerEntry?
    /// True when the stage failed and then passed on an immediate re-run (the
    /// flake gate). Optional so older records decode.
    var flaky: Bool?
    /// `.testMap` map op: change in the map's counters since the run's first map.
    var testMapDelta: [String: Double]? = nil
    /// `.testMap` ledger op: ids of the faults it created.
    var newFaults: [String]? = nil
    /// `.codeGraph` verify op: the refactor batch (`R<n>`) this verify checked.
    /// Set on the refactor apply stage's attempt too, from the plan diff.
    var batchId: String? = nil
    /// `.codeGraph` verify op: change in each graph counter since the snapshot.
    var graphDelta: [String: Double]? = nil

    init(stageId: String, stageName: String, kind: LoopStage.Kind,
         severity: LoopStageSeverity, startedAt: Date, durationSeconds: Double,
         exitCode: Int32?, passed: Bool, outputTail: String, outputHash: String?,
         score: Int?, repairAttempted: Bool = false,
         repairDurationSeconds: Double? = nil, repairAttemptIndex: Int? = nil,
         changedPaths: [String] = [],
         scopeVerdict: RepairScopeVerdict = .notChecked,
         errored: Bool? = nil, agentNote: String? = nil,
         ledger: LoopLedgerEntry? = nil, flaky: Bool? = nil) {
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
        self.repairDurationSeconds = repairDurationSeconds
        self.repairAttemptIndex = repairAttemptIndex
        self.changedPaths = changedPaths
        self.scopeVerdict = scopeVerdict
        self.errored = errored
        self.agentNote = agentNote
        self.ledger = ledger
        self.flaky = flaky
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
    /// Optional so records written before this field existed still decode.
    /// 0 = the run could wait on a pause indefinitely.
    var pauseTimeoutSeconds: Double?

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
        pauseTimeoutSeconds = config.pauseTimeoutSeconds
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
    /// Where the run's edits went after it succeeded (a merge request, or why
    /// not). `nil` for every run that did not try — it failed, changed nothing,
    /// or opening requests was off — and for every record written before this
    /// existed. Optional, so older records decode.
    var shipment: LoopShipment? = nil
    /// The refactor batch this run rolled back (design doc §3.5). `nil` for
    /// every run that rolled nothing back and for every record written before
    /// this existed. Optional, so older records decode.
    var batchRollback: LoopBatchRollback? = nil
    /// The refactor batches this run applied and verified, and those the apply
    /// stage skipped, in order (design doc §3.6). `nil` for every run that
    /// finished no batch and for every record written before several batches
    /// per run existed. Optional, so older records decode.
    var appliedBatches: [String]? = nil
    var skippedBatches: [String]? = nil

    /// `Applied: R1, R2 · Rolled back: R3 (blocked: …)`, or nil when the run
    /// kept no batch (`RefactorBatchSequence.batchesSummary`).
    var batchesSummary: String? {
        RefactorBatchSequence.batchesSummary(applied: appliedBatches ?? [], skipped: skippedBatches ?? [],
                                             rolledBack: batchRollback?.listEntry)
    }

    var durationSeconds: Double { endedAt.timeIntervalSince(startedAt) }
}

/// A refactor batch a failed run took back out of the tree (Mikado rollback,
/// design doc §3.5): which batch, what ended the run, and whether the tree is
/// really back to its pre-batch state. The plan marks the batch `blocked` —
/// or, when the ending did not implicate the batch, puts it back to `todo`
/// (`backToTodo`, `RefactorBatchRollback.planOutcome`); `treeRestored == false`
/// says the edits are still in the tree (and is always `blocked`).
struct LoopBatchRollback: Codable, Equatable {
    var batchId: String
    /// The stage whose ending triggered the rollback.
    var stageName: String
    /// Why the run ended: the `- Blocked:` reason written into the plan, or,
    /// for a batch put back to `todo`, the same words, kept for the record only.
    var reason: String
    /// Repo-relative paths put back from the batch base (or that would have
    /// been, when the restore could not run), sorted.
    var restoredPaths: [String]
    var treeRestored: Bool
    /// Why the tree was not restored, or the plan not marked; nil when both worked.
    var problem: String?
    /// True when the batch went back to `todo` (retried as-is next run) rather
    /// than `blocked`. Nil — never false — otherwise, so records written
    /// before this field existed read the same as a blocked batch.
    var backToTodo: Bool? = nil
    /// Paths a partial rollback deliberately left as it found them (changed
    /// outside the batch, or not verifiably created by it). Nil when none, so
    /// older records decode unchanged.
    var leftAlonePaths: [String]? = nil

    /// One line for the summary note and the finish notification.
    var summary: String {
        if !treeRestored, let left = leftAlonePaths, !left.isEmpty {
            return "\(batchId) PARTLY rolled back — \(restoredPaths.count) path(s) restored, "
                + "\(left.count) left as found (\(left.joined(separator: ", "))); blocked: \(reason)"
                + (problem.map { " — \($0)" } ?? "")
        }
        guard treeRestored else {
            return "\(batchId) NOT rolled back — tree left as the batch made it (\(problem ?? "unknown")); blocked: \(reason)"
        }
        let label = backToTodo == true ? "back to todo" : "blocked"
        return "\(batchId) rolled back (\(label): \(reason))" + (problem.map { " — \($0)" } ?? "")
    }

    /// This rollback as one entry of the run's batch list (`RefactorBatchSequence.batchesSummary`).
    var listEntry: String {
        RefactorBatchSequence.rolledBackEntry(batchId: batchId, reason: reason,
                                              treeRestored: treeRestored, problem: problem,
                                              backToTodo: backToTodo == true,
                                              restoredCount: restoredPaths.count,
                                              leftAlone: leftAlonePaths ?? [])
    }
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

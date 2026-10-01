import AppKit
import Foundation
import CryptoKit

/// Drives a Loop Engineering run: repeats the full ordered stage list,
/// on a `.shellCommand` failure calls `stageRepairer` and retries, on a
/// `.regressionSweep` failure just retries (the sweep already made its
/// own one-shot repair attempt internally). Every iteration re-runs
/// every stage from the top so a fix to a later stage can't silently
/// leave an earlier one broken.
///
/// Four properties make this a harness rather than a retry loop:
/// - **Every run is journalled** to `<faultsRoot>/system/loop-runs/` via
///   `LoopRunJournaling`, so a run remains inspectable after the app quits.
/// - **Repairs are scope-checked** by `RepairScopeGuarding`: a stage that only
///   turns green because the repair edited a test or a build file is reported
///   `.blocked`, never `.success`.
/// - **Progress is measured, not guessed.** `ProgressWatch` + `StageOutputParser`
///   compare failing-test counts across iterations and feed the delta back to the
///   repair agent as evidence, falling back to output-hash comparison for
///   unrecognised runners.
/// - **Four independent budgets** bound a run: iterations, per-stage
///   non-improving streak, wall clock, and repairs per stage.
@MainActor
final class LoopEngineRunner: ObservableObject {
    // `LoopLogLine` (was a nested `LogLine` here) now lives in
    // Core/Contracts/LoopRunning.swift — `LoopRunning.onLog` must be able to
    // name this type without naming `LoopEngineRunner` itself.

    @Published private(set) var running = false
    /// Admission covers queue/worktree provisioning as well as execution.
    /// `running` becomes true only after the root lock is acquired, so it
    /// cannot by itself prevent the same instance entering twice while waiting.
    private var isAdmitted = false
    /// True while this instance is waiting in `LoopRunQueue` for another run
    /// on the same git root to finish.
    @Published private(set) var waitingInQueue = false
    /// Live lease for the in-flight run's worktree, when it has one — read by
    /// Task 9's incident-triage stage, which must never edit the main checkout.
    private(set) var currentWorktreeLease: LoopWorktreeManager.Lease?
    @Published private(set) var log: [LoopLogLine] = []
    @Published private(set) var status: LoopEngineStatus?
    @Published private(set) var iteration = 0

    /// Live state of one stage within the in-flight run, for a pipeline
    /// display. Distinct from the journal's `LoopStageAttempt` (durable,
    /// per-attempt) — this is the ephemeral "what is happening right now"
    /// signal the log lines alone could not provide.
    enum LiveStageState: Equatable {
        case pending, running, repairing, passed, failed
        /// The stage could not run at all (the agent call failed with a
        /// transport/backend error after its retry) — distinct from `.failed`,
        /// which means it ran and did not pass.
        case errored
    }

    /// Per-stage live state, keyed by stage id. Reset to `.pending` at the
    /// top of every iteration (the loop re-runs every stage from the top, and
    /// the display must say so); left holding the final states after a run —
    /// available to any post-run surface (today's header hides itself when
    /// the run ends, so nothing renders them yet) until the next run resets it.
    @Published private(set) var stageStates: [String: LiveStageState] = [:]
    /// Name of the stage executing (or repairing) right now, `nil` between
    /// stages and between runs.
    @Published private(set) var currentStageName: String?
    /// When the in-flight run started, `nil` between runs — the elapsed-time
    /// and budget displays derive from this rather than a published timer, so
    /// the runner never ticks state it has no use for itself.
    @Published private(set) var runStartedAt: Date?
    /// The in-flight run's own budgets, snapshotted at start. Published (not
    /// read from the page's editable state) so the display describes the run
    /// actually executing even after the user edits the config mid-run.
    @Published private(set) var runMaxIterations = 0
    @Published private(set) var runWallClockBudget: TimeInterval?

    /// True while the run is holding between stages at the user's request.
    ///
    /// A pause takes effect at the next STAGE BOUNDARY, never mid-stage: a
    /// stage is somebody's build or test suite, and suspending one (SIGSTOP on
    /// a compiler, a half-written build directory) is a good way to corrupt
    /// the very thing being verified. So `pause()` is honest about what it
    /// does — the current stage runs to completion, then the loop holds.
    @Published private(set) var paused = false
    /// Seconds this run spent paused. Excluded from the wall-clock budget:
    /// a user pausing to read a failure must not spend the run's time budget
    /// doing it, or a long pause would silently end the run as
    /// `.wallClockExceeded` with nothing having been running.
    @Published private(set) var pausedSeconds: TimeInterval = 0
    private var pauseStartedAt: Date?

    /// Paused seconds INCLUDING a pause still in progress.
    ///
    /// `pausedSeconds` only folds in a pause when it is released, so any
    /// display or budget arithmetic that used it directly would charge the
    /// current pause to the run — the very thing `pausedSeconds` exists to
    /// prevent. Takes `now` rather than reading the clock so a caller
    /// already redrawing on a timeline uses that tick's instant.
    func pausedSeconds(asOf now: Date) -> TimeInterval {
        pausedSeconds + (pauseStartedAt.map { max(0, now.timeIntervalSince($0)) } ?? 0)
    }

    /// Working (non-paused) seconds this run has spent — what the wall-clock
    /// budget is actually measured against, and what the live header shows.
    func workingElapsed(since startedAt: Date, asOf now: Date) -> TimeInterval {
        max(0, now.timeIntervalSince(startedAt) - pausedSeconds(asOf: now))
    }

    /// Git roots whose in-flight run is holding at a pause.
    ///
    /// A pause keeps the run's `LoopRunQueue` lock — the hold is inside the
    /// critical section — so anything waiting on the same repo waits until
    /// the pause is released. Queued surfaces read this to say so instead of
    /// showing an unexplained "waiting for the current run" forever.
    @MainActor private static var pausedRootKeys: Set<String> = []

    /// Whether the run currently holding `gitRoot` is paused.
    @MainActor
    static func isPausedRun(gitRoot: URL) -> Bool {
        pausedRootKeys.contains(gitRoot.resolvingSymlinksInPath().path)
    }

    /// The lock key this run holds, for the paused-roots registry. Set at
    /// admission; `nil` between runs.
    private var lockRootKeyForPause: String?

    /// Optional mirror for every log line this runner emits, so a surface that
    /// does not own the runner can still follow a run.
    ///
    /// `log` above is instance state on a `@StateObject`, which means it is
    /// reachable only from the view that owns it. Nothing else — the Auto Tasks
    /// page, the activity feed, the iPhone — could see progress WITHIN a run;
    /// they got the terminal outcome and nothing else. A sink at the single
    /// append site is enough to fix that without moving any ownership.
    var onLog: ((LoopLogLine) -> Void)?
    /// Called when a run is admitted (`true`, before any queue wait) and when
    /// it ends (`false`), with the run's project and loop. `LoopRunService`
    /// uses it to show — and stop — a lane run on the Loop page.
    var onAdmissionChange: ((_ projectId: String?, _ loopId: String, _ active: Bool) -> Void)?

    /// Whether ANY runner instance is mid-run on `gitRoot`, resolved the same
    /// way `LoopRunQueue` keys it. Read-only view of the process-wide lock, for
    /// callers that need to report on a run they do not own — the mobile
    /// bridge asks this so the phone can never show "idle" while the desktop
    /// is mid-run, without either side having to share a runner instance.
    @MainActor
    static func isRunActive(gitRoot: URL) -> Bool {
        let key = gitRoot.resolvingSymlinksInPath().path
        if LoopRunQueue.isActive(rootKey: key) { return true }
        if LoopWorktreeManager.activeWorktreeRunCount(mainRepo: gitRoot) > 0 { return true }
        return false
    }

    /// Runs waiting behind the in-flight one for `gitRoot`, if any.
    @MainActor
    static func queuedRunCount(gitRoot: URL) -> Int {
        LoopRunQueue.queuedCount(rootKey: gitRoot.resolvingSymlinksInPath().path)
    }

    /// Per-main-root run counts by loop id. Counts (not a Set) matter when two
    /// worktrees run the same loop concurrently: one finishing must not clear
    /// the other's indicator.
    @MainActor private static var activeLoopCounts: [String: [String: Int]] = [:]

    @MainActor
    static func isLoopActive(loopId: String, gitRoot: URL) -> Bool {
        let rootKey = gitRoot.resolvingSymlinksInPath().path
        return (activeLoopCounts[rootKey]?[loopId] ?? 0) > 0
    }

    private static func registerActiveLoop(rootKey: String, loopId: String) {
        activeLoopCounts[rootKey, default: [:]][loopId, default: 0] += 1
    }

    private static func unregisterActiveLoop(rootKey: String, loopId: String) {
        guard var loops = activeLoopCounts[rootKey],
              let count = loops[loopId] else { return }
        if count <= 1 {
            loops.removeValue(forKey: loopId)
        } else {
            loops[loopId] = count - 1
        }
        activeLoopCounts[rootKey] = loops.isEmpty ? nil : loops
    }

    private let verifier: FaultVerifier
    private let stageRepairer: LoopStageRepairer
    private let regressionSweep: RegressionSweepRunning
    private let skillExecutor: LoopSkillExecuting
    private let approvals: VerifyApprovalStore
    /// Fallback ceiling for a stage whose own `timeoutSeconds` is nil. 0 = no
    /// limit, which is the default: a stage command is the user's build or test
    /// suite, and cutting it off reports a timeout for work that was still
    /// running. `ShellFaultVerifier` treats <= 0 as unbounded and leans on
    /// `ResourceGuardService` instead.
    private let stageTimeout: TimeInterval
    /// App-wide defaults (Settings → Loop) for a stage that sets no timeout of
    /// its own and when `stageTimeout` is 0. 0 = no limit (the test default).
    var defaultShellTimeout: TimeInterval
    var defaultAgentTimeout: TimeInterval
    private let journal: LoopRunJournaling
    private let summaryWriter: LoopRunSummaryWriting
    private let scopeGuard: RepairScopeGuarding
    private let trigger: LoopRunTrigger
    /// Registers the run's main git root with the server's repo allow-list
    /// before the first agent call. nil (tests) skips registration.
    private let repoRegistrar: LoopRepoRegistering?
    /// The current run's main git root, and whether it is registered yet.
    private var runMainGitRoot: URL?
    private var repoRegisteredThisRun = false

    /// Stages already warned about an unparseable failure count this run —
    /// the notice is per stage, not per iteration, or a 10-iteration run
    /// would repeat it ten times.
    private var unrecognisedRunnerStages: Set<String> = []
    /// Shell stages already flake-checked this run (the check happens once per
    /// stage per run, before its first repair).
    private var flakeCheckedStages: Set<String> = []
    /// Names of stages that failed then passed on the flake gate's re-run this
    /// run — surfaced in the summary note and the finish notification.
    private(set) var flakyStages: [String] = []
    /// The last failed artifact check's message, handed to the generate (skill)
    /// stages of the retry so they fix what it found. Cleared when the check passes.
    private var artifactCheckFeedback: String?
    /// The triage stage's selected batch for this run, kept so a retried
    /// iteration re-uses it instead of selecting (and growing) a fresh one.
    /// Reset per run.
    private var selfHealBatch: [Incident]?
    private var selfHealSuppression: UUID?

    /// Accumulated journal state for the in-flight run. Instance state rather
    /// than a `run`-local `var` only because the per-stage helpers below append
    /// to it; `@MainActor` makes that safe.
    private var iterationRecords: [LoopIterationRecord] = []

    /// The latest agent result per stage id for the current run — what each
    /// skill stage and each repair's agent said and changed. Kept (rather than
    /// discarded, as before) so a later repair attempt can be given its
    /// predecessor's reply. Reset at the start of every run.
    private(set) var lastSkillResults: [String: LoopAgentResult] = [:]
    private(set) var lastRepairResults: [String: LoopAgentResult] = [:]
    /// This run's repair attempts per stage id (the attempt ledger), oldest first.
    private var attemptLedgers: [String: [LoopLedgerEntry]] = [:]

    /// The identifying parameters of `run`'s current call, or `nil` between
    /// runs. `run`'s own parameters are locals, invisible to
    /// `handleAppTerminating()` — which fires from a notification, not from
    /// inside `run` — so this is the only way that method can find them.
    private struct RunContext {
        let config: LoopEngineConfig
        let faultsRoot: URL
        let gitRoot: URL
        let projectId: String?
        let startedAt: Date
        let loopId: String
        let loopName: String
        let runId: String
    }
    private var currentRunContext: RunContext?

    init(verifier: FaultVerifier = ShellFaultVerifier(),
         stageRepairer: LoopStageRepairer,
         regressionSweep: RegressionSweepRunning,
         skillExecutor: LoopSkillExecuting,
         approvals: VerifyApprovalStore = VerifyApprovalStore(),
         stageTimeout: TimeInterval = 0,
         journal: LoopRunJournaling = FileLoopRunJournal(),
         summaryWriter: LoopRunSummaryWriting = NoteLoopRunSummaryWriter(),
         scopeGuard: RepairScopeGuarding = GitRepairScopeGuard(),
         trigger: LoopRunTrigger = .manual,
         repoRegistrar: LoopRepoRegistering? = nil,
         transportRetryDelay: TimeInterval = 2,
         defaultShellTimeout: TimeInterval = 0,
         defaultAgentTimeout: TimeInterval = 0) {
        self.transportRetryDelay = transportRetryDelay
        self.repoRegistrar = repoRegistrar
        self.verifier = verifier
        self.stageRepairer = stageRepairer
        self.regressionSweep = regressionSweep
        self.skillExecutor = skillExecutor
        self.approvals = approvals
        self.stageTimeout = stageTimeout
        self.defaultShellTimeout = defaultShellTimeout
        self.defaultAgentTimeout = defaultAgentTimeout
        self.journal = journal
        self.summaryWriter = summaryWriter
        self.scopeGuard = scopeGuard
        self.trigger = trigger
        // Same idiom as `BackendManager.init` — best-effort cleanup so an
        // in-flight run leaves a trace instead of vanishing on Cmd-Q/logout.
        // `[weak self]` means a runner that's already been deallocated (e.g.
        // its owning view was closed) makes this a no-op rather than a crash.
        terminationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleAppTerminating()
            }
        }
    }

    private var terminationObserver: NSObjectProtocol?

    /// Pause before the single retry of an agent call that failed with a
    /// transient transport error (`isRetryableTransport`). Tests pass 0.
    private let transportRetryDelay: TimeInterval

    deinit {
        if let terminationObserver {
            NotificationCenter.default.removeObserver(terminationObserver)
        }
    }

    /// Best-effort, fully synchronous interruption path for app termination
    /// (Cmd-Q, logout) — the counterpart to `finish()` for the one exit `run`
    /// itself can never take. `willTerminate` runs on the main thread with a
    /// tight budget before the OS reaps the process, so this cannot `await`
    /// anything: it snapshots whatever `iterationRecords` already hold and
    /// writes them directly through the (synchronous) `journal.write`. Without
    /// this, a run cut off mid-stage left no trace at all — `finish()`, the
    /// run's only journal write, is reached by cooperative cancellation or a
    /// normal exit, neither of which fires when the process is simply killed
    /// out from under the `Task` that was awaiting `run`.
    func handleAppTerminating() {
        guard running, let ctx = currentRunContext else { return }
        // Kill whatever shell command is currently running (e.g. a `swift
        // test`/`npm test` stage) so it doesn't outlive the app as an orphan —
        // `ShellFaultVerifier` registered it with this guard for exactly this.
        ResourceGuardService.shared.stopAll(reason: "app is quitting")
        let record = LoopRunRecord(
            id: ctx.runId, projectId: ctx.projectId, trigger: trigger,
            gitRoot: ctx.gitRoot.path, startedAt: ctx.startedAt, endedAt: Date(),
            iterationsUsed: iteration, config: LoopRunConfigSnapshot(ctx.config),
            iterations: iterationRecords, statusCode: LoopEngineStatus.aborted.code,
            statusSummary: LoopEngineStatus.aborted.summary,
            loopId: ctx.loopId, loopName: ctx.loopName)
        _ = journal.write(record, root: ctx.faultsRoot)
    }

    func clearLog() { log.removeAll() }

    /// Ask the run to hold at the next stage boundary. No-op unless a run is
    /// executing — a queued run has nothing to pause (it is already waiting),
    /// and pausing "the next run" is not a thing a Pause button should mean.
    func pause() {
        guard running, !paused else { return }
        paused = true
        pauseStartedAt = Date()
        if let lockRootKeyForPause {
            Self.pausedRootKeys.insert(lockRootKeyForPause)
        }
        appendLog(.warn, "Pausing — the loop will hold once the current stage finishes. Other runs on this repo wait until you resume.")
    }

    /// Release a hold. Safe to call when not paused.
    func resume() {
        guard paused else { return }
        paused = false
        if let pauseStartedAt {
            pausedSeconds += Date().timeIntervalSince(pauseStartedAt)
        }
        pauseStartedAt = nil
        if let lockRootKeyForPause {
            Self.pausedRootKeys.remove(lockRootKeyForPause)
        }
        appendLog(.info, "Resumed")
    }

    /// Blocks while `paused`, returning immediately when the run is not
    /// paused (the overwhelmingly common case, so it must cost nothing).
    ///
    /// Deliberately a poll rather than a stored continuation: a continuation
    /// parked here has to be resumed from a cancellation handler running off
    /// this actor, and getting that wrong deadlocks a run permanently — the
    /// exact failure a Pause button must never have. A 200 ms wake-up while
    /// explicitly paused is free, and `Task.sleep` throwing on cancellation
    /// is what lets Stop end a paused run.
    private func holdWhilePaused() async {
        while paused && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    /// What the loop should do after one stage finished.
    private enum StageDecision: Equatable {
        /// Move on to the next stage — the stage passed, or it failed but is
        /// `.advisory` and therefore does not gate.
        case proceed
        /// A blocking stage failed and was handled (repaired or not); restart the
        /// iteration from the first stage.
        case retryIteration
        /// A blocking stage failed and was repaired: re-verify THAT stage alone.
        /// The full pipeline re-runs only once it passes.
        case retryStage
        /// End the run with this status.
        case terminate(LoopEngineStatus)
    }

    /// Runs `config`'s ordered stages to completion, success, or give-up.
    ///
    /// Returns `nil` when the run never started at all — this instance is
    /// already mid-run, or the call was cancelled while waiting in
    /// `LoopRunQueue`. When another runner already holds the same
    /// `gitRoot`, this call waits in the queue and then runs normally.
    /// Callers MUST check for `nil` rather than assume every call produced
    /// a real status: `status` is only meaningful when this returns non-nil.
    /// Otherwise returns the final `LoopEngineStatus` (also available
    /// afterwards via `status`).
    ///
    /// - Parameters:
    ///   - faultsRoot: project root passed through to the regression sweep, and
    ///     the root the run journal is written beneath.
    ///   - gitRoot: git working tree shell-command stages run in,
    ///     approvals are keyed against, and the concurrency lock key.
    ///   - projectId: recorded in the journal so runs can be attributed to a
    ///     project later. Optional — a missing id degrades analysis, never the run.
    ///   - loopId: which `LoopDefinition` this run executes — recorded on the
    ///     journal and exposed via `isLoopActive(loopId:gitRoot:)`. Defaulted so every
    ///     pre-existing caller (and every existing test) is unaffected; real
    ///     callers pass the loop's actual id.
    ///   - loopName: the loop's name at run time, recorded alongside `loopId`.
    ///   - goal: free text describing what this loop is trying to achieve. When
    ///     set, woven into the repair/skill prompts this run builds (a later
    ///     task wires this up — for now the parameter is only accepted and
    ///     stored/passed through).
    ///   - acceptanceCriteria: same treatment as `goal` (also wired up later).
    ///   - scopeGlobs: optional path allowlist. Empty (the default) means
    ///     unrestricted. Enforcement is live in `withScopeGuard`: a changed
    ///     path matching none of these globs is treated as a violation exactly
    ///     like a protected-path hit (same revert/warn/stop policy).
    @discardableResult
    func run(config: LoopEngineConfig, faultsRoot: URL, gitRoot: URL,
             projectId: String? = nil, loopId: String = "primary", loopName: String = "Loop",
             goal: String? = nil, acceptanceCriteria: String? = nil,
             scopeGlobs: [String] = []) async -> LoopEngineStatus? {
        guard !isAdmitted else {
            appendLog(.warn, "Loop not started · this runner instance is already active")
            return nil
        }
        isAdmitted = true
        onAdmissionChange?(projectId, loopId, true)
        defer {
            isAdmitted = false
            onAdmissionChange?(projectId, loopId, false)
        }
        let mainGitRoot = gitRoot
        let mainRootKey = mainGitRoot.resolvingSymlinksInPath().path
        var runGitRoot = mainGitRoot
        var lockRootKey = mainRootKey
        var worktreeLease: LoopWorktreeManager.Lease?
        var worktreeRequiredFailure: String?

        for note in await LoopWorktreeManager.pruneStale(mainRepo: mainGitRoot, faultsRoot: faultsRoot) {
            appendLog(.info, "Worktree cleanup · \(note)")
        }

        if config.alwaysUseWorktree {
            do {
                let lease = try await LoopWorktreeManager.create(mainRepo: mainGitRoot, faultsRoot: faultsRoot,
                                                                 requireCleanMain: false)
                worktreeLease = lease
                runGitRoot = lease.worktreePath
                lockRootKey = runGitRoot.resolvingSymlinksInPath().path
                appendLog(.info, "Isolated worktree \(lease.worktreePath.lastPathComponent)")
            } catch {
                // Never fall back to the main checkout: this loop promises to leave it untouched.
                worktreeRequiredFailure = "This loop needs an isolated worktree: \(error.localizedDescription)"
            }
        } else if config.useWorktreesForConcurrentRuns && LoopRunQueue.willWait(rootKey: mainRootKey) {
            if let lease = await LoopWorktreeManager.createIfPossible(mainRepo: mainGitRoot,
                                                                      faultsRoot: faultsRoot) {
                worktreeLease = lease
                runGitRoot = lease.worktreePath
                lockRootKey = runGitRoot.resolvingSymlinksInPath().path
                appendLog(.info,
                          "Parallel run · isolated worktree \(lease.worktreePath.lastPathComponent)")
            }
        }
        currentWorktreeLease = worktreeLease

        if worktreeLease == nil && LoopRunQueue.willWait(rootKey: mainRootKey) {
            let ahead = LoopRunQueue.queuedCount(rootKey: mainRootKey)
            let place = ahead + 1
            appendLog(.info, "Queued · waiting for another run on this repo (\(place) ahead)")
        }
        waitingInQueue = worktreeLease == nil && LoopRunQueue.willWait(rootKey: mainRootKey)
        defer { waitingInQueue = false }
        do {
            try await LoopRunQueue.acquire(rootKey: lockRootKey)
            // Cleared HERE, not only by the defer: the defer runs at function
            // exit, which left a run that had to queue reporting "waiting"
            // for its entire execution — every consumer (the toolbar label,
            // the live header) showed "Queued" over a run that was running.
            waitingInQueue = false
        } catch {
            if let lease = worktreeLease {
                await LoopWorktreeManager.finish(lease)
            }
            // The success defer below (which also clears this) never registers
            // on this early-exit path, so clear it here too: otherwise a run
            // cancelled while queued leaves `currentWorktreeLease` pointing at
            // a worktree `finish` just removed, and Task 9 would read a stale lease.
            currentWorktreeLease = nil
            if error is CancellationError {
                // An explicit stop while still queued is still an abort — the
                // user cancelled, same as line ~460 for mid-run cancellation.
                // Returning nil here made it indistinguishable from "busy".
                appendLog(.warn, "Loop aborted · cancelled while queued")
                status = .aborted
                return .aborted
            } else {
                appendLog(.warn, "Loop not started · \(error.localizedDescription)")
            }
            return nil
        }
        Self.registerActiveLoop(rootKey: mainRootKey, loopId: loopId)
        running = true
        status = nil
        iteration = 0
        iterationRecords = []
        let startedAt = Date()
        runStartedAt = startedAt
        runMaxIterations = config.maxIterations
        runWallClockBudget = config.wallClockBudgetSeconds
        stageStates = [:]
        lastSkillResults = [:]
        lastRepairResults = [:]
        attemptLedgers = [:]
        runMainGitRoot = mainGitRoot
        repoRegisteredThisRun = false
        unrecognisedRunnerStages = []
        flakeCheckedStages = []
        flakyStages = []
        artifactCheckFeedback = nil
        selfHealBatch = nil
        // Must be reset per run, not only in the defer: a run that ended while
        // paused would otherwise leave `paused == true`, and the NEXT run
        // would hold at its first stage boundary forever with no visible
        // cause.
        paused = false
        pausedSeconds = 0
        pauseStartedAt = nil
        lockRootKeyForPause = lockRootKey
        currentRunContext = RunContext(config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                                       projectId: projectId, startedAt: startedAt,
                                       loopId: loopId, loopName: loopName,
                                       runId: UUID().uuidString)
        // Runs an earlier process left without a final record become .aborted
        // records first; then this run's own crash-safe log begins.
        _ = await journal.reconcileOncePerLaunch(root: faultsRoot)
        emit(LoopRunEvent(kind: LoopRunEvent.Kind.started, start: .init(
            id: currentRunContext?.runId ?? "", projectId: projectId, trigger: trigger,
            gitRoot: runGitRoot.path, startedAt: startedAt, config: LoopRunConfigSnapshot(config),
            loopId: loopId, loopName: loopName)))
        defer {
            running = false
            // `stageStates` is deliberately NOT cleared: the final per-stage
            // outcome stays available until the next run resets it.
            currentStageName = nil
            runStartedAt = nil
            // A run must never end still holding a pause — see the reset at
            // run start for what that would do to the following run.
            paused = false
            pauseStartedAt = nil
            // Must be cleared here too: a run cancelled while paused releases
            // the queue lock via this same defer, and leaving the key behind
            // would make every later run on this repo look paused.
            Self.pausedRootKeys.remove(lockRootKey)
            lockRootKeyForPause = nil
            Self.unregisterActiveLoop(rootKey: mainRootKey, loopId: loopId)
            currentRunContext = nil
            LoopRunQueue.release(rootKey: lockRootKey)
            if let lease = worktreeLease {
                Task { await LoopWorktreeManager.finish(lease) }
            }
            currentWorktreeLease = nil
        }

        // Shell commands and repairs run in `runGitRoot`; approvals stay keyed to
        // the linked main checkout so worktree runs do not need re-approval.
        let approvalRepo = mainGitRoot

        // Disabled stages are skipped entirely — not run, not preflighted.
        // Preflighting them anyway would let a disabled stage's missing
        // command or approval block a run it takes no part in.
        let orderedStages = LoopStage.runOrder(config.stages.filter { $0.enabled && $0.kind != .unsupported })
        // Keyed on the stage list, not `loopId`: a duplicated Self-Heal loop
        // (new id) or a wizard-built loop that happens to include a Triage
        // stage must still suppress its own errors from feeding back in.
        if orderedStages.contains(where: { $0.kind == .incidentTriage }) {
            selfHealSuppression = IncidentRecorder.beginSuppression()
        }
        let disabledCount = config.stages.count - orderedStages.count
        guard !orderedStages.isEmpty else {
            // Two different user errors, two different fixes — "enable one"
            // is nonsense advice for a config with no stages at all.
            let reason = config.stages.isEmpty
                ? "No stages configured"
                : config.stages.allSatisfy({ $0.kind == .unsupported })
                ? "This loop's stages need a newer version of LLM-IDE"
                : "Every stage is disabled — enable at least one"
            appendLog(.warn, "Loop not run · \(reason)")
            return await finish(.error(reason),
                                config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                                projectId: projectId, startedAt: startedAt,
                                loopId: loopId, loopName: loopName)
        }
        if let failure = worktreeRequiredFailure {
            appendLog(.error, "Loop not run · \(failure)")
            return await finish(.blocked(reason: .worktreeRequired(reason: failure)),
                                config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                                projectId: projectId, startedAt: startedAt,
                                loopId: loopId, loopName: loopName)
        }
        let skippedNote = disabledCount > 0 ? " (\(disabledCount) disabled stage(s) skipped)" : ""
        appendLog(.info, "Loop started · \(orderedStages.count) stage(s), max \(config.maxIterations) iteration(s)\(skippedNote)")

        // Preflight: every stage's static config is checked BEFORE any
        // iteration runs — burning iterations/LLM repair calls on an
        // earlier stage only to discover a LATER stage is unapproved or
        // misconfigured would waste both, and per spec, needing approval
        // must not itself consume an iteration.
        for stage in orderedStages {
            switch stage.kind {
            case .shellCommand:
                if let problem = Self.commandProblem(stage) {
                    // Full explanation to the log, short form to the status —
                    // see `CommandProblem` for the five surfaces the status
                    // string lands in.
                    appendLog(.error, "  [\(stage.name)] \(problem.detail)")
                    return await finish(.error(problem.status),
                                        config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                                        projectId: projectId, startedAt: startedAt,
                                        loopId: loopId, loopName: loopName)
                }
                if LoopStageDetector.isWatchScript(stage.command ?? "") {
                    appendLog(.warn, "  [\(stage.name)] the command uses --watch; it may never exit (CI=1 is set, but a watcher flag overrides it)")
                }
                guard let command = Self.validCommand(stage) else {
                    // Unreachable: `commandProblem` above returns non-nil for
                    // exactly the cases `validCommand` rejects. Fail closed
                    // rather than force-unwrap.
                    return await finish(.error("Stage \"\(stage.name)\" has no runnable command"),
                                        config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                                        projectId: projectId, startedAt: startedAt,
                                        loopId: loopId, loopName: loopName)
                }
                guard LoopStageApproval.isApproved(stage, command: command, repo: approvalRepo,
                                                   approvals: approvals, fresh: true) else {
                    appendLog(.warn, "  [\(stage.name)] needs approval: \(command)")
                    return await finish(.needsApproval(stageName: stage.name),
                                        config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                                        projectId: projectId, startedAt: startedAt,
                                        loopId: loopId, loopName: loopName)
                }
            case .skill:
                // A generate stage with no skill chosen would fire a bare
                // agent call with no skill framing at all — uncontrolled
                // edits, silently, every iteration. That is a config error
                // on par with a shell stage with no command.
                guard let skillId = stage.skillId,
                      !skillId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return await finish(.error("Stage \"\(stage.name)\" has no skill chosen"),
                                        config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                                        projectId: projectId, startedAt: startedAt,
                                        loopId: loopId, loopName: loopName)
                }
            case .artifactCheck:
                // Resolve Output-following rules exactly as the evaluator
                // will: the shipped Plan/Docs checks carry only
                // `outputRules`, so the raw spec looks empty; a blanked
                // Output still resolves to nothing and fails here.
                guard let check = stage.check?.resolved(against: orderedStages),
                      !(check.requiredPaths.isEmpty && check.lineLimits.isEmpty && check.citationGlobs.isEmpty) else {
                    return await finish(.error("Stage \"\(stage.name)\" has no checks configured"),
                                        config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                                        projectId: projectId, startedAt: startedAt,
                                        loopId: loopId, loopName: loopName)
                }
            case .regressionSweep, .unsupported, .incidentTriage:
                break
            }
        }

        // One stall detector for every stage kind, keyed by stage id. Keyed per
        // stage (not shared) so stage A failing, being repaired, and passing
        // cannot contaminate stage B's streak just because B later fails with a
        // coincidentally similar failure.
        var progress = ProgressWatch()
        /// Repairs spent per stage this run — `maxRepairsPerStage`'s counter.
        var repairsUsed: [String: Int] = [:]

        // Code-applying stages that already applied their batch this run. A
        // failed verify's `.retryIteration` re-runs every stage from the top;
        // re-running the apply stage would stack the NEXT batch onto a tree
        // the tests have not yet proven, so it runs at most once per run.
        var codeAppliedStageIDs = Set<String>()
        iterationLoop: while iteration < config.maxIterations {
            // `RegressionSweepRunning.sweep` is fail-closed and
            // returns `false` on cancellation rather than throwing, so a
            // cancelled regression-sweep-only run would otherwise just
            // burn every remaining iteration as ordinary failures and
            // report `.givenUp(.maxIterations)` — checking here catches
            // that path too, not just the shell-command one below.
            if Task.isCancelled {
                status = .aborted
                break iterationLoop
            }

            // Wall-clock budget. Checked here only — "stop starting new work",
            // never a hard kill of a stage mid-flight (that is what the per-stage
            // timeout is for). Deliberately skipped for the first iteration: a
            // run must always get one complete pass, because a budget small
            // enough to expire during startup would otherwise make the loop a
            // confusing no-op rather than a fast failure.
            // Working elapsed, not raw: time the user spent holding the run is
            // not time the run spent working, and charging it to the budget
            // would end a paused run for "exceeding" a limit nothing was
            // consuming. Same accessor the live header uses, so the number the
            // user watches is the number this decides on.
            if iteration >= 1, let budget = config.wallClockBudgetSeconds,
               workingElapsed(since: startedAt, asOf: Date()) > budget {
                appendLog(.warn, "Time budget of \(Int(budget))s exceeded after \(iteration) iteration(s)")
                status = .givenUp(reason: .wallClockExceeded)
                break iterationLoop
            }

            iteration += 1
            iterationRecords.append(LoopIterationRecord(index: iteration))
            emit(LoopRunEvent(kind: LoopRunEvent.Kind.iterationStarted, iteration: iteration))
            appendLog(.info, "Iteration \(iteration)/\(config.maxIterations)")
            // Every iteration re-runs every stage from the top — the pipeline
            // display must show that, not keep last iteration's verdicts.
            stageStates = Dictionary(uniqueKeysWithValues:
                orderedStages.map { ($0.id, LiveStageState.pending) })

            // The stage a repair just touched: it is re-verified alone, and the
            // pipeline restarts from the top only after it passes.
            var retriedStageID: String?
            var stageIndex = 0
            while stageIndex < orderedStages.count {
                let stage = orderedStages[stageIndex]
                // The stage boundary is where a pause takes effect (see
                // `pause()`), and it is also the only place a Stop pressed
                // BETWEEN stages was previously invisible until the next
                // iteration — the verifier notices cancellation mid-stage,
                // but nothing checked before starting the following one.
                await holdWhilePaused()
                if Task.isCancelled {
                    status = .aborted
                    break iterationLoop
                }
                currentStageName = stage.name
                stageStates[stage.id] = .running
                emit(LoopRunEvent(kind: LoopRunEvent.Kind.stageStarted, iteration: iteration,
                                  stageId: stage.id, stageName: stage.name))
                let decision: StageDecision
                switch stage.kind {
                case .regressionSweep:
                    decision = await runRegressionStage(
                        stage, config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                        progress: &progress, scopeGlobs: scopeGlobs)
                case .shellCommand:
                    decision = await runShellStage(
                        stage, config: config, gitRoot: runGitRoot,
                        progress: &progress, repairsUsed: &repairsUsed,
                        goal: goal, acceptanceCriteria: acceptanceCriteria, scopeGlobs: scopeGlobs)
                case .artifactCheck:
                    decision = await runArtifactCheckStage(
                        stage, config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                        stages: orderedStages, progress: &progress)
                case .incidentTriage:
                    decision = runTriageStage(stage, gitRoot: runGitRoot)
                case .unsupported:
                    // Filtered out of `orderedStages` above; fail closed if one
                    // ever gets here — an unknown stage kind is never run.
                    decision = .proceed
                case .skill where LoopStage.lacksVerifyAfter(stage, in: orderedStages):
                    decision = refuseUnverifiedCodeApply(stage)
                case .skill where stage.appliesCode && codeAppliedStageIDs.contains(stage.id):
                    appendLog(.info, "  [\(stage.name)] \(Self.codeAlreadyAppliedMessage(stage))")
                    stageStates[stage.id] = .passed
                    decision = .proceed
                case .skill:
                    decision = await runSkillStage(
                        stage, config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                        goal: goal, acceptanceCriteria: acceptanceCriteria, scopeGlobs: scopeGlobs)
                    // Only an apply that actually RAN counts as applied: an
                    // errored one (the agent never answered) applied nothing,
                    // so the retry must run it again, not skip it as done.
                    if stage.appliesCode, stageStates[stage.id] != .errored {
                        codeAppliedStageIDs.insert(stage.id)
                    }
                }

                switch decision {
                case .proceed:
                    if retriedStageID == stage.id {
                        // The repaired stage passes: confirm the whole pipeline.
                        // Same iteration — the re-verify already paid for it.
                        appendLog(.info, "  [\(stage.name)] passes after repair — re-running the full pipeline")
                        retriedStageID = nil
                        stageStates = Dictionary(uniqueKeysWithValues:
                            orderedStages.map { ($0.id, LiveStageState.pending) })
                        stageIndex = 0
                    } else {
                        stageIndex += 1
                    }
                case .retryStage:
                    // Each repair + stage-only re-verify is charged as one
                    // iteration, so `maxIterations` still bounds repair rounds.
                    if let budget = config.wallClockBudgetSeconds,
                       workingElapsed(since: startedAt, asOf: Date()) > budget {
                        appendLog(.warn, "Time budget of \(Int(budget))s exceeded after \(iteration) iteration(s)")
                        status = .givenUp(reason: .wallClockExceeded)
                        break iterationLoop
                    }
                    retriedStageID = stage.id
                    iteration += 1
                    iterationRecords.append(LoopIterationRecord(index: iteration))
                    emit(LoopRunEvent(kind: LoopRunEvent.Kind.iterationStarted, iteration: iteration))
                    appendLog(.info, "Iteration \(iteration)/\(config.maxIterations) — re-verifying \(stage.name)")
                case .retryIteration:
                    continue iterationLoop
                case .terminate(let terminal):
                    status = terminal
                    break iterationLoop
                }
            }

            if status == nil {
                status = .success
                break iterationLoop
            }
        }

        // The `Task.isCancelled` check at the top of the loop only catches
        // cancellation that happens BETWEEN iterations — a give-up path
        // (`.givenUp(.maxIterations)` or `.repeatedFailure`) reached
        // during the FINAL iteration never loops back to that check, so a
        // cancellation that raced with the last iteration would otherwise
        // still report a give-up instead of `.aborted`. Check once more
        // here so cancellation always wins over a give-up verdict.
        if Task.isCancelled, status != .success {
            status = .aborted
        }
        let verdict = Self.honestVerdict(status ?? .givenUp(reason: .maxIterations),
                                         iterations: iterationRecords)
        return await finish(verdict,
                            config: config, faultsRoot: faultsRoot, gitRoot: runGitRoot,
                            projectId: projectId, startedAt: startedAt,
                            loopId: loopId, loopName: loopName)
    }

    // MARK: - Stage execution

    private func runRegressionStage(_ stage: LoopStage, config: LoopEngineConfig,
                                    faultsRoot: URL, gitRoot: URL,
                                    progress: inout ProgressWatch,
                                    scopeGlobs: [String] = []) async -> StageDecision {
        let startedAt = Date()
        // The sweep's own fault repairs are agent edits like any other: each
        // runs inside the protected-path guard (and the transport retry). The
        // findings are collected here and judged once the sweep returns; a
        // repair the policy rejects is not kept, so the sweep never re-verifies
        // a fault whose test the repair just edited.
        var findings: [(verdict: RepairScopeVerdict, violations: [String], changed: [String])] = []
        let repairGuard: FaultRepairGuard = { [weak self] repoRoot, repair in
            // Fail closed: with the runner gone there is no guard to run the
            // repair inside, so it is rejected, never run unguarded.
            guard let self else { return false }
            try await self.ensureRepoRegistered()
            let guarded = await self.withScopeGuard(stage: stage, config: config, gitRoot: repoRoot,
                                                    scopeGlobs: scopeGlobs) {
                let result = try await self.withTransportRetry(stage: stage) {
                    try await repair(self.agentTimeout(for: stage))
                }
                if let note = Self.agentRunNote(result) {
                    self.appendLog(.warn, "  [\(stage.name)] fault repair: \(note)")
                }
                return result
            }
            switch guarded {
            case .failed(let error, let verdict, let violations, let changed):
                findings.append((verdict, violations, changed))
                throw error
            case .completed(let verdict, let violations, let changed):
                findings.append((verdict, violations, changed))
                let rejected = (verdict == .violated || verdict == .violatedReverted)
                    && [.revert, .stop].contains(Self.effectivePolicy(for: stage, config: config))
                return !rejected
            }
        }
        // The run's remaining budget bounds the sweep (verify timeouts and
        // whether a repair may start), like every other stage kind.
        var deadline: Date?
        if let budget = runWallClockBudget, let started = runStartedAt {
            deadline = Date().addingTimeInterval(max(0, budget - workingElapsed(since: started, asOf: Date())))
        }
        regressionSweep.setRepairModel(config.repairModel)
        let outcome = await regressionSweep.sweep(
            faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: true, repairGuard: repairGuard,
            deadline: deadline)
        let duration = Date().timeIntervalSince(startedAt)
        let changed = Array(Set(findings.flatMap(\.changed))).sorted()
        let violations = Array(Set(findings.flatMap(\.violations))).sorted()
        let scopeVerdict = Self.worstVerdict(findings.map(\.verdict))
        // The failing-fault count IS the score here — no parsing needed. The
        // same line is the log entry, the journal's output tail, and the hash
        // input, so it is built once.
        let line = Self.regressionLine(outcome)
        appendLog(outcome.passed ? .info : .warn, "  [\(stage.name)] \(line)")

        // A violation ends the run whatever the sweep concluded: a sweep that
        // "passed" because a repair edited the fault's test must not pass.
        if let terminal = scopeTermination(stage: stage, config: config,
                                           verdict: scopeVerdict, violations: violations) {
            stageStates[stage.id] = .failed
            record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                   passed: false, output: line, score: outcome.failingCount,
                   changedPaths: changed, scopeVerdict: scopeVerdict)
            return .terminate(terminal)
        }

        if outcome.passed {
            stageStates[stage.id] = .passed
            record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                   passed: true, output: "", score: 0,
                   changedPaths: changed, scopeVerdict: scopeVerdict)
            // A pass restarts the stall watch so a later failure in the same run
            // counts from scratch.
            progress.clear(key: stage.id)
            return .proceed
        }

        stageStates[stage.id] = .failed
        let score = outcome.failingCount
        let verdict = progress.record(key: stage.id, score: score, hash: Self.hash(line))
        record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
               passed: false, output: line, score: score,
               changedPaths: changed, scopeVerdict: scopeVerdict)

        if stage.severity == .advisory {
            appendLog(.warn, "  [\(stage.name)] advisory — not gating the run")
            return .proceed
        }
        // An unapproved verify command cannot start passing on a retry — only a
        // human approving it can change that — so re-running the loop would
        // burn every iteration on the same answer.
        if outcome.needsApproval > 0 {
            return .terminate(.needsApproval(stageName: stage.name))
        }
        if verdict.streak >= config.consecutiveFailureStop {
            return .terminate(.givenUp(reason: .regressionStalled))
        }
        if iteration >= config.maxIterations {
            return .terminate(.givenUp(reason: .maxIterations))
        }
        return .retryIteration
    }

    private func runShellStage(_ stage: LoopStage, config: LoopEngineConfig, gitRoot: URL,
                               progress: inout ProgressWatch,
                               repairsUsed: inout [String: Int],
                               goal: String? = nil, acceptanceCriteria: String? = nil,
                               scopeGlobs: [String] = []) async -> StageDecision {
        // Preflight already validated this once per stage; if a command somehow
        // becomes invalid by the time we get here, fail closed instead of
        // force-unwrapping.
        guard let command = Self.validCommand(stage) else {
            stageStates[stage.id] = .failed
            // Same rule and same wording as preflight — a command that became
            // unrunnable mid-run (an edit landing between preflight and here)
            // must fail closed with the reason, not a generic error.
            let problem = Self.commandProblem(stage)
            if let problem { appendLog(.error, "  [\(stage.name)] \(problem.detail)") }
            return .terminate(.error(problem?.status
                                     ?? "Stage \"\(stage.name)\" has no runnable command"))
        }

        let startedAt = Date()
        let timeout = shellTimeout(for: stage)
        let outcome: VerifyOutcome
        // A timed-out stage's `output` is a synthesized sentence, not the
        // runner's own output, so nothing can be concluded from the parser
        // failing to score it — see the unrecognised-runner notice below.
        var didTimeOut = false
        do {
            outcome = try await verifier.verify(command: command, repoRoot: gitRoot, timeout: timeout)
        } catch is CancellationError {
            // Terminate paths must not leave the state stuck at `.running` —
            // the retained post-run states would then claim a stage was still
            // executing after the run ended. `.pending`, not `.failed`: a
            // cancelled stage produced no verdict, and asserting failure
            // would bake the wrong answer into any post-run display.
            stageStates[stage.id] = .pending
            return .terminate(.aborted)
        } catch VerifyError.timedOut(let seconds) {
            // A timeout means the stage never confirmed passing — treat it like an
            // ordinary non-zero-exit failure (same score/retry/repair path below),
            // not a fatal run-ending error. Only a genuine launch failure below is
            // fatal.
            outcome = VerifyOutcome(exitCode: -1, output: "stage timed out after \(seconds)s")
            didTimeOut = true
            // The budget clamp (`shellTimeout`) is what cut this stage short:
            // end the run rather than spend a repair the budget cannot cover.
            if budgetExhausted() {
                appendLog(.warn, "  [\(stage.name)] stopped · the run's time budget ran out mid-stage")
                stageStates[stage.id] = .failed
                record(stage, startedAt: startedAt, duration: Date().timeIntervalSince(startedAt),
                       exitCode: -1, passed: false, output: outcome.output, score: nil)
                return .terminate(.givenUp(reason: .wallClockExceeded))
            }
        } catch VerifyError.stoppedForResources(let reason) {
            // Explicitly NOT the timeout path above: a resource stop must not be
            // scored as a stage failure, because a failing stage is what triggers
            // an LLM repair — and dispatching a repair is the last thing to do
            // while the machine is already under critical memory pressure. End the
            // run and say why.
            appendLog(.warn, "  [\(stage.name)] \(reason)")
            // `.pending`, not `.failed` — a resource stop is deliberately not
            // scored as a stage failure (see the comment above), and the live
            // state must not contradict that.
            stageStates[stage.id] = .pending
            return .terminate(.error(reason))
        } catch {
            appendLog(.error, "  [\(stage.name)] error: \(error.localizedDescription)")
            stageStates[stage.id] = .failed
            return .terminate(.error(error.localizedDescription))
        }
        let duration = Date().timeIntervalSince(startedAt)

        // Parse + hash off the main actor: the output can be up to the
        // verifier's 256 KB cap, and regexes over it stalled the UI per stage.
        let analysis = await Self.analyse(outcome.output, hashing: outcome.exitCode != 0)
        settleLedger(stageId: stage.id, passed: outcome.exitCode == 0, failureSet: analysis.hash)
        if outcome.exitCode == 0 {
            appendLog(.info, "  [\(stage.name)] passed")
            stageStates[stage.id] = .passed
            record(stage, startedAt: startedAt, duration: duration, exitCode: 0,
                   passed: true, output: "", score: analysis.score)
            progress.clear(key: stage.id)
            return .proceed
        }

        stageStates[stage.id] = .failed
        let score = analysis.score
        let failureHash = analysis.hash
        let excerpt = String(outcome.output.suffix(500))
        // The note text itself is pure — composed by `StageOutputParser.failureNote`
        // (exit 127 > a recognised failure count > a timeout > "not recognised", in
        // that priority order) and asserted directly against that real code path in
        // loop-contract-lab, not reimplemented there. Only the once-per-run SIDE
        // EFFECT below (an unrecognised runner silently downgrades the loop's stall
        // detector from "did the failure COUNT shrink" to "is the output
        // byte-identical", which cannot see thrashing at all) stays here, since it
        // needs the runner's mutable `unrecognisedRunnerStages` state.
        let (scoreNote, isUnrecognised) = StageOutputParser.failureNote(
            exitCode: outcome.exitCode, command: command, output: outcome.output,
            score: score, didTimeOut: didTimeOut)
        if isUnrecognised, !unrecognisedRunnerStages.contains(stage.id) {
            unrecognisedRunnerStages.insert(stage.id)
            appendLog(.warn, "  [\(stage.name)] this runner's output has no failure count we recognise — progress is judged by comparing output instead, which cannot tell a changing failure from a shrinking one")
        }
        appendLog(.warn, "  [\(stage.name)] FAILED (exit \(outcome.exitCode))\(scoreNote): \(excerpt)")

        let verdict = progress.record(key: stage.id, score: score, hash: failureHash,
                                        ids: analysis.ids.isEmpty ? nil : analysis.ids)

        if stage.severity == .advisory {
            appendLog(.warn, "  [\(stage.name)] advisory — not gating the run")
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, outputHash: failureHash, score: score)
            return .proceed
        }

        let used = repairsUsed[stage.id] ?? 0
        // The same failure set back after two repairs with DIFFERENT diffs: a
        // third guess at it is not worth the spend.
        if !verdict.stoppedReporting,
           LoopAttemptLedger.returnedAfterDifferentDiffs(attemptLedgers[stage.id] ?? [], current: failureHash) {
            appendLog(.warn, "  [\(stage.name)] the same failure returned after two different fixes — stopping")
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, outputHash: failureHash, score: score)
            return .terminate(.givenUp(reason: .repeatedFailure))
        }
        // The attempt right after a count disappeared always gets its repair,
        // even at `consecutiveFailureStop` — that repair is the only one told
        // "your last change stopped the tests from running", and stopping
        // before it would give up on the one piece of evidence that matters.
        // Likewise the first no-progress verdict (streak 2) after ONE repair
        // always gets one informed repair: the first was blind, this one has
        // the attempt ledger.
        if verdict.streak >= config.consecutiveFailureStop, !verdict.stoppedReporting,
           !(used == 1 && verdict.streak == 2) {
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, outputHash: failureHash, score: score)
            if verdict.notReporting {
                return .terminate(.givenUp(reason: .stoppedReporting(stageName: stage.name)))
            }
            // A measured, unchanging failure COUNT and a byte-identical failure are
            // different diagnoses and get different statuses: `.noProgress` says
            // "the failures kept changing but never shrank" (thrashing), which a
            // hash comparison cannot detect at all.
            let reason: LoopEngineStatus.GivenUpReason =
                (score != nil && verdict.previousScore != nil)
                    ? .noProgress(stageName: stage.name)
                    : .repeatedFailure
            return .terminate(.givenUp(reason: reason))
        }
        if iteration >= config.maxIterations {
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, outputHash: failureHash, score: score)
            return .terminate(.givenUp(reason: .maxIterations))
        }

        if used >= config.maxRepairsPerStage {
            appendLog(.warn, "  [\(stage.name)] repair budget of \(config.maxRepairsPerStage) exhausted")
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, outputHash: failureHash, score: score)
            return .terminate(.givenUp(reason: .repairBudgetExhausted(stageName: stage.name)))
        }

        if budgetExhausted() {
            appendLog(.warn, "  [\(stage.name)] no repair · the run's time budget is used up")
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, outputHash: failureHash, score: score)
            return .terminate(.givenUp(reason: .wallClockExceeded))
        }

        // The output the repair is shown: the failure itself, or the flake
        // gate's re-run when that failed differently.
        var repairOutput = outcome.output
        // Flake gate: before the FIRST repair of this stage in this run, run it
        // once more. A pass means the failure was not real — no repair.
        if used == 0, !didTimeOut, outcome.exitCode != 127, !flakeCheckedStages.contains(stage.id) {
            flakeCheckedStages.insert(stage.id)
            appendLog(.info, "  [\(stage.name)] failed — re-running once to rule out a flake")
            stageStates[stage.id] = .running
            let rerunStartedAt = Date()
            do {
                let again = try await verifier.verify(command: command, repoRoot: gitRoot,
                                                      timeout: shellTimeout(for: stage))
                if again.exitCode == 0 {
                    appendLog(.warn, "  [\(stage.name)] FLAKY — failed, then passed on an immediate re-run; not repairing")
                    record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                           passed: false, output: outcome.output, outputHash: failureHash, score: score)
                    record(stage, startedAt: rerunStartedAt, duration: Date().timeIntervalSince(rerunStartedAt),
                           exitCode: 0, passed: true, output: "", score: nil,
                           agentNote: "flaky: failed once, passed on immediate re-run", flaky: true)
                    flakyStages.append(stage.name)
                    stageStates[stage.id] = .passed
                    progress.clear(key: stage.id)
                    return .proceed
                }
                // Failed again: journal the re-run, and show the repair what
                // the stage says NOW if it failed differently.
                let again2 = await Self.analyse(again.output, hashing: true)
                record(stage, startedAt: rerunStartedAt, duration: Date().timeIntervalSince(rerunStartedAt),
                       exitCode: again.exitCode, passed: false, output: again.output,
                       outputHash: again2.hash, score: again2.score)
                if again2.hash != failureHash { repairOutput = again.output }
            } catch is CancellationError {
                stageStates[stage.id] = .pending
                return .terminate(.aborted)
            } catch VerifyError.stoppedForResources(let reason) {
                appendLog(.warn, "  [\(stage.name)] \(reason)")
                stageStates[stage.id] = .pending
                return .terminate(.error(reason))
            } catch {
                // Inconclusive (timeout, launch error): treat as still failing.
            }
            stageStates[stage.id] = .failed
            // The re-run may have used up the budget: end, don't start a repair.
            if budgetExhausted() {
                appendLog(.warn, "  [\(stage.name)] no repair · the run's time budget is used up")
                record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                       passed: false, output: outcome.output, outputHash: failureHash, score: score)
                return .terminate(.givenUp(reason: .wallClockExceeded))
            }
        }

        do {
            try await ensureRepoRegistered()
        } catch {
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, outputHash: failureHash, score: score)
            if Self.isCancellation(error) { return .terminate(.aborted) }
            appendLog(.error, "  [\(stage.name)] \(error.localizedDescription)")
            return .terminate(.error(error.localizedDescription))
        }
        appendLog(.info, "  [\(stage.name)] repairing…")
        emit(LoopRunEvent(kind: LoopRunEvent.Kind.repairRequested, iteration: iteration,
                          stageId: stage.id, stageName: stage.name,
                          detail: "attempt \(used + 1) of \(config.maxRepairsPerStage)"))
        stageStates[stage.id] = .repairing
        repairsUsed[stage.id] = used + 1
        let evidence = RepairEvidence(
            attempt: used + 1, previousScore: verdict.previousScore, currentScore: score,
            improved: verdict.improved, streak: verdict.streak,
            stoppedRunning: verdict.notReporting,
            errorExcerpt: verdict.notReporting ? analysis.errorLines : nil,
            ledger: attemptLedgers[stage.id] ?? [],
            priorRunLedger: used == 0 ? await priorRunLedger(stageId: stage.id, failureSet: failureHash) : [])

        // Timed around the guard, not just the agent call: the scope check's
        // two `git status` runs are part of what a repair costs in wall clock,
        // and splitting them out would report a repair as faster than the run
        // actually waited.
        let treeBefore = await scopeGuard.snapshotTree(gitRoot: gitRoot)
        let repairStartedAt = Date()
        var repairResult: LoopAgentResult?
        let guarded = await withScopeGuard(stage: stage, config: config, gitRoot: gitRoot,
                                           scopeGlobs: scopeGlobs) {
            let failureOutput = Self.prependGoalContext(
                repairOutput, goal: goal, acceptanceCriteria: acceptanceCriteria,
                reservedForTruncation: AgentLoopStageRepairer.maxFailureOutputChars)
            repairResult = try await self.withTransportRetry(stage: stage) {
                try await self.stageRepairer.repair(
                    stageName: stage.name, command: command, failureOutput: failureOutput,
                    evidence: evidence, repoRoot: gitRoot, timeout: self.agentTimeout(for: stage),
                    model: config.repairModel)
            }
            return repairResult
        }
        let repairDuration = Date().timeIntervalSince(repairStartedAt)
        let repairIndex = used + 1
        lastRepairResults[stage.id] = repairResult
        emit(LoopRunEvent(kind: LoopRunEvent.Kind.repairReplied, iteration: iteration,
                          stageId: stage.id, stageName: stage.name,
                          detail: String(format: "%.1fs", repairDuration)))
        // A repair's refusals and non-success ending are recorded, not fatal:
        // the next iteration's re-run of the stage decides whether it worked.
        let repairNote = Self.agentRunNote(repairResult)
        if let repairNote { appendLog(.warn, "  [\(stage.name)] repair \(used + 1): \(repairNote)") }

        // The repair finished either way; the stage itself is still failed —
        // the next iteration's re-run (or the terminal status) says whether
        // the repair worked, and a chip stuck on "repairing" would claim
        // otherwise.
        stageStates[stage.id] = .failed

        let changedForLedger: [String]
        switch guarded {
        case .failed(_, _, _, let changed): changedForLedger = changed
        case .completed(_, _, let changed): changedForLedger = changed
        }
        let ledgerEntry = await makeLedgerEntry(
            n: used + 1, changed: changedForLedger, reply: repairResult?.reply ?? "",
            failureSet: failureHash, config: config, gitRoot: gitRoot, treeBefore: treeBefore)
        attemptLedgers[stage.id, default: []].append(ledgerEntry)

        switch guarded {
        case .failed(let error, let verdictScope, let violations, let changed):
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, outputHash: failureHash, score: score, repairAttempted: true,
                   repairDuration: repairDuration, repairIndex: repairIndex,
                   changedPaths: changed, scopeVerdict: verdictScope, agentNote: repairNote,
                   ledger: ledgerEntry)
            if Self.isCancellation(error) { return .terminate(.aborted) }
            // What a failed repair left behind is judged before its error:
            // a protected-path violation says more than "the request failed".
            if let terminal = scopeTermination(stage: stage, config: config,
                                              verdict: verdictScope, violations: violations) {
                return .terminate(terminal)
            }
            appendLog(.error, "  [\(stage.name)] repair \(repairIndex) failed after \(Int(repairDuration))s: \(error.localizedDescription)")
            return .terminate(.error(error.localizedDescription))
        case .completed(let verdictScope, let violations, let changed):
            appendLog(.info, "  [\(stage.name)] repair \(repairIndex)/\(config.maxRepairsPerStage) took \(Int(repairDuration))s")
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, outputHash: failureHash, score: score, repairAttempted: true,
                   repairDuration: repairDuration, repairIndex: repairIndex,
                   changedPaths: changed, scopeVerdict: verdictScope, agentNote: repairNote,
                   ledger: ledgerEntry)
            if let terminal = scopeTermination(stage: stage, config: config,
                                              verdict: verdictScope, violations: violations) {
                return .terminate(terminal)
            }
            return .retryStage
        }
    }

    /// A code-applying stage (`LoopStage.appliesCode`) with no enabled verify
    /// stage after it in this run (`LoopStage.lacksVerifyAfter`) — reached by
    /// "Run this stage only", a disabled Test stage, or a hand-built loop. It
    /// is refused WITHOUT calling the skill executor, recorded as failed, and
    /// ends the run as an error: an edit nothing re-tests must never land.
    static func unverifiedCodeApplyMessage(_ stage: LoopStage) -> String {
        "\(stage.name) needs an enabled test stage after it; skipped — nothing was edited"
    }

    /// Logged when a code-applying stage is reached again in the same run
    /// (after a failed verify's retry): it is skipped without calling the
    /// skill executor, so a retry repairs the batch already applied instead
    /// of applying the next one.
    static func codeAlreadyAppliedMessage(_ stage: LoopStage) -> String {
        "\(stage.name) already applied its batch this run; skipped"
    }

    /// The extra root a skill stage's agent gets: `<projectRoot>/llm-doc` when
    /// it lies OUTSIDE `gitRoot` (the split layout, `<project>/code/<repo>`,
    /// or a Loop worktree under `<project>/system/loop-worktrees/`), created
    /// when missing. Mirrors the server's acceptance rule so a project it
    /// would refuse never gets a 400: the project must be an LLM-IDE project
    /// (`system/project.json`) and `gitRoot` must sit at most 3 levels below
    /// it. `[]` otherwise — including when the project root IS the repo,
    /// where llm-doc is already inside the confinement.
    nonisolated static func skillExtraRoots(projectRoot: URL, gitRoot: URL,
                                            fileManager: FileManager = .default) -> [URL] {
        let project = projectRoot.resolvingSymlinksInPath().standardizedFileURL
        let repo = gitRoot.resolvingSymlinksInPath().standardizedFileURL
        let projectPath = project.path
        let repoPath = repo.path
        guard repoPath == projectPath || repoPath.hasPrefix(projectPath + "/") else { return [] }
        let depth = repoPath == projectPath ? 0
            : repoPath.dropFirst(projectPath.count + 1).split(separator: "/").count
        guard depth > 0, depth <= 3 else { return [] }
        guard fileManager.fileExists(atPath: project.appendingPathComponent("system/project.json").path)
        else { return [] }
        let llmDoc = project.appendingPathComponent("llm-doc", isDirectory: true)
        var isDir: ObjCBool = false
        if !fileManager.fileExists(atPath: llmDoc.path, isDirectory: &isDir) {
            guard (try? fileManager.createDirectory(at: llmDoc, withIntermediateDirectories: true)) != nil
            else { return [] }
        } else if !isDir.boolValue {
            return []
        }
        return [llmDoc]
    }

    /// Why an agent call could not be made: the server would refuse the repo.
    struct RepoNotRegisteredError: LocalizedError, Equatable {
        let path: String
        let reason: String
        var errorDescription: String? { "repo \(path) is not registered with the server (\(reason))" }
    }

    /// Registers the run's main git root with the server's repo allow-list,
    /// once per run, before its first agent call (worktrees are then accepted
    /// as linked worktrees of it). Throws `RepoNotRegisteredError`, or the
    /// cancellation, when that fails.
    private func ensureRepoRegistered() async throws {
        guard let repoRegistrar, let root = runMainGitRoot, !repoRegisteredThisRun else { return }
        do {
            try await LoopRepoRoot.register(repoRegistrar, root: root)
            repoRegisteredThisRun = true
        } catch {
            if Self.isCancellation(error) || error is LoopRepoRoot.TooBroadError { throw error }
            throw RepoNotRegisteredError(path: root.path, reason: error.localizedDescription)
        }
    }

    /// The budget for one agent call on `stage`: the smaller of the stage's
    /// timeout (its own `timeoutSeconds`, else the runner's fallback when set)
    /// and what is left of the run's wall-clock budget; nil when neither
    /// exists (the server's default then applies). Evaluated at call time, so
    /// a late repair gets only the time the run still has.
    func agentTimeout(for stage: LoopStage, now: Date = Date()) -> TimeInterval? {
        let stageLimit: TimeInterval?
        if let own = stage.timeoutSeconds {
            stageLimit = own > 0 ? TimeInterval(own) : nil     // explicit 0 = no limit
        } else if stageTimeout > 0 {
            stageLimit = stageTimeout
        } else {
            stageLimit = defaultAgentTimeout > 0 ? defaultAgentTimeout : nil
        }
        return clampToBudget(stageLimit, now: now)
    }

    /// The timeout handed to the shell verifier (0 = unbounded): the stage's
    /// own limit, else the runner fallback, else the app default — clamped to
    /// what is left of the run's wall-clock budget, so a stage cannot outlive
    /// the budget (the watchdog). An explicit `timeoutSeconds` of 0 means the
    /// user wants no stage limit; the budget clamp still applies.
    func shellTimeout(for stage: LoopStage, now: Date = Date()) -> TimeInterval {
        let limit: TimeInterval?
        if let own = stage.timeoutSeconds {
            limit = own > 0 ? TimeInterval(own) : nil
        } else if stageTimeout > 0 {
            limit = stageTimeout
        } else {
            limit = defaultShellTimeout > 0 ? defaultShellTimeout : nil
        }
        return clampToBudget(limit, now: now) ?? 0
    }

    private func clampToBudget(_ stageLimit: TimeInterval?, now: Date) -> TimeInterval? {
        var remaining: TimeInterval?
        if let budget = runWallClockBudget, let started = runStartedAt {
            // Never 0 or negative: the server rejects that; an overrun run
            // gets a minimal slot and the budget check ends it after.
            remaining = max(1, budget - workingElapsed(since: started, asOf: now))
        }
        switch (stageLimit, remaining) {
        case let (limit?, left?): return min(limit, left)
        case let (limit?, nil): return limit
        case let (nil, left?): return left
        case (nil, nil): return nil
        }
    }

    /// True once the run's working time has used up its wall-clock budget.
    private func budgetExhausted(now: Date = Date()) -> Bool {
        guard let budget = runWallClockBudget, let started = runStartedAt else { return false }
        return workingElapsed(since: started, asOf: now) >= budget
    }

    /// Why a skill stage whose agent run returned must still FAIL, or nil:
    ///   - the run ended with a result subtype other than "success"
    ///     (`error_max_turns`, `error_during_execution`, …);
    ///   - a requested skill was truncated — the agent never saw all of it;
    ///   - tool calls were refused AND the run changed nothing (nothing in the
    ///     repo per the server or the guard, nothing in an extra root) — the
    ///     classic split-layout symptom of every plan write being denied.
    nonisolated static func skillRunFailure(_ result: LoopAgentResult,
                                            guardChanged: [String]) -> String? {
        if let subtype = result.resultSubtype, subtype != "success" {
            return "the agent run did not finish (\(subtype))"
        }
        if !result.truncatedSkills.isEmpty {
            return "skill \(result.truncatedSkills.joined(separator: ", ")) was too long and was cut off — "
                + "the agent did not see all of it"
        }
        if let first = result.denied.first, result.changedPaths.isEmpty,
           result.changedExtraPaths.isEmpty, guardChanged.isEmpty {
            return "the agent changed nothing; its tool calls were refused: \(first.reason)"
        }
        return nil
    }

    /// A one-line account of an agent run's non-success ending and refused
    /// tool calls, for the stage record; nil when there is nothing to say.
    nonisolated static func agentRunNote(_ result: LoopAgentResult?) -> String? {
        guard let result else { return nil }
        var parts: [String] = []
        if let subtype = result.resultSubtype, subtype != "success" { parts.append("agent run ended \(subtype)") }
        if let first = result.denied.first {
            parts.append("\(result.denied.count) tool call(s) refused, first: \(first.reason)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: "; ")
    }

    /// Why a skill stage failed when the server could not resolve its skill.
    nonisolated static func skillNotInstalledMessage(_ skillIds: [String]) -> String {
        skillIds.count == 1
            ? "skill \(skillIds[0]) is not installed"
            : "skills \(skillIds.joined(separator: ", ")) are not installed"
    }

    private func refuseUnverifiedCodeApply(_ stage: LoopStage) -> StageDecision {
        let message = Self.unverifiedCodeApplyMessage(stage)
        appendLog(.error, "  [\(stage.name)] \(message)")
        stageStates[stage.id] = .failed
        record(stage, startedAt: Date(), duration: 0, exitCode: nil,
               passed: false, output: message, score: nil)
        return .terminate(.error(message))
    }

    /// An in-app artifact check (no shell, no agent). A failure of a BLOCKING
    /// check re-runs the pipeline from the top — the generate stages before it
    /// get the failure as feedback — bounded by `maxIterations`, the wall-clock
    /// budget, and the same no-progress rule as every other stage (the failing
    /// item count is its score). Code-applying stages still run at most once.
    private func runArtifactCheckStage(_ stage: LoopStage, config: LoopEngineConfig,
                                       faultsRoot: URL, gitRoot: URL, stages: [LoopStage],
                                       progress: inout ProgressWatch) async -> StageDecision {
        guard let spec = stage.check else {
            stageStates[stage.id] = .failed
            return .terminate(.error("Stage \"\(stage.name)\" has no checks configured"))
        }
        let startedAt = Date()
        let roots = ArtifactCheckEvaluator.Roots(repo: gitRoot, project: faultsRoot)
        // File IO off the main actor.
        let result = await Task.detached(priority: .utility) {
            ArtifactCheckEvaluator.evaluate(spec, roots: roots, stages: stages)
        }.value
        let duration = Date().timeIntervalSince(startedAt)
        if Task.isCancelled {
            stageStates[stage.id] = .pending
            return .terminate(.aborted)
        }
        if result.passed {
            appendLog(.info, "  [\(stage.name)] passed")
            stageStates[stage.id] = .passed
            record(stage, startedAt: startedAt, duration: duration, exitCode: 0, passed: true, output: "", score: nil)
            progress.clear(key: stage.id)
            artifactCheckFeedback = nil
            return .proceed
        }

        stageStates[stage.id] = .failed
        let message = result.message
        let hash = Self.hash(message)
        let score = result.failures.count
        appendLog(.warn, "  [\(stage.name)] FAILED (\(score) problem(s)): \(message.prefix(500))")
        record(stage, startedAt: startedAt, duration: duration, exitCode: 1, passed: false,
               output: message, outputHash: hash, score: score)
        if stage.severity == .advisory {
            appendLog(.warn, "  [\(stage.name)] advisory — not gating the run")
            return .proceed
        }
        let verdict = progress.record(key: stage.id, score: score, hash: hash)
        if verdict.streak >= config.consecutiveFailureStop {
            return .terminate(.givenUp(reason: .noProgress(stageName: stage.name)))
        }
        if iteration >= config.maxIterations { return .terminate(.givenUp(reason: .maxIterations)) }
        if budgetExhausted() {
            appendLog(.warn, "  [\(stage.name)] no retry · the run's time budget is used up")
            return .terminate(.givenUp(reason: .wallClockExceeded))
        }
        artifactCheckFeedback = message
        appendLog(.info, "  [\(stage.name)] re-running the generate stages with the findings")
        return .retryIteration
    }

    /// Self-Heal Phase 2: selects a batch of new incidents and writes it for
    /// the fix agent. Re-runs of the same run keep the first batch — selecting
    /// again would grow it (and re-mark more incidents `.fixing`) every
    /// iteration instead of giving the fix agent a stable target.
    private func runTriageStage(_ stage: LoopStage, gitRoot: URL) -> StageDecision {
        let startedAt = Date()
        let batch = selfHealBatch ?? SelfHealBatch.select(from: .shared, max: SelfHealSettings.maxPerRun())
        selfHealBatch = batch
        guard !batch.isEmpty else {
            stageStates[stage.id] = .passed
            appendLog(.info, "  [\(stage.name)] no new incidents — nothing to fix")
            record(stage, startedAt: startedAt, duration: 0, exitCode: nil, passed: true,
                   output: "no new incidents", score: nil)
            return .terminate(.success)
        }
        let file = gitRoot.appendingPathComponent(SelfHealBatch.relativePath)
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try SelfHealBatch.render(batch).write(to: file, atomically: true, encoding: .utf8)
        } catch {
            stageStates[stage.id] = .failed
            record(stage, startedAt: startedAt, duration: 0, exitCode: nil, passed: false,
                   output: error.localizedDescription, score: nil)
            return .terminate(.error("Could not write \(SelfHealBatch.relativePath): \(error.localizedDescription)"))
        }
        stageStates[stage.id] = .passed
        appendLog(.info, "  [\(stage.name)] \(batch.count) incident(s) → \(SelfHealBatch.relativePath)")
        record(stage, startedAt: startedAt, duration: Date().timeIntervalSince(startedAt), exitCode: nil,
               passed: true, output: batch.map(\.id).joined(separator: ", "), score: nil)
        return .proceed
    }

    private func runSkillStage(_ stage: LoopStage, config: LoopEngineConfig,
                              faultsRoot: URL, gitRoot: URL,
                              goal: String? = nil, acceptanceCriteria: String? = nil,
                              scopeGlobs: [String] = []) async -> StageDecision {
        let skillId = stage.skillId ?? ""
        let stagePaths = LoopStagePaths.resolve(stage, gitRoot: gitRoot, projectRoot: faultsRoot)
        var composed = Self.composeSkillMessage(stage, paths: stagePaths)
        if let feedback = artifactCheckFeedback {
            composed += "\n\nThe previous pass's output failed these automatic checks. Fix exactly these, "
                + "changing nothing else:\n" + String(feedback.prefix(3000))
        }
        let message = Self.prependGoalContext(composed, goal: goal,
                                              acceptanceCriteria: acceptanceCriteria)
        let startedAt = Date()
        appendLog(.info, "  [\(stage.name)] running skill \(skillId.isEmpty ? "(none set)" : skillId) (generate)")

        // A skill stage is a generate step that edits the tree, so it gets the
        // same protected-path guard as a repair: "make the tests pass" is as
        // available to a skill as it is to the repairer.
        // `gitRoot` is the run's root — the worktree when this run was
        // redirected into one — and it is what the agent is confined to.
        // In the split layout the project's llm-doc/ (plans, docs, the
        // refactor plan) sits outside the git root; the agent is let into it.
        let extraRoots = Self.skillExtraRoots(projectRoot: faultsRoot, gitRoot: gitRoot)
        // An Input/Output outside the agent's confinement would make it write
        // nothing while the stage "passes": refuse before calling the agent.
        if let problem = stagePaths.outsideProblem(roots: [gitRoot] + extraRoots)
            ?? stagePaths.throwawayProblem(stageName: stage.name, stage: stage, gitRoot: gitRoot) {
            stageStates[stage.id] = .failed
            appendLog(.error, "  [\(stage.name)] \(problem)")
            record(stage, startedAt: startedAt, duration: 0, exitCode: nil,
                   passed: false, output: problem, score: nil)
            return .terminate(.error(problem))
        }
        do {
            try await ensureRepoRegistered()
        } catch {
            let cancelled = Self.isCancellation(error)
            stageStates[stage.id] = cancelled ? .pending : .failed
            record(stage, startedAt: startedAt, duration: Date().timeIntervalSince(startedAt), exitCode: nil,
                   passed: false, output: error.localizedDescription, score: nil)
            if cancelled { return .terminate(.aborted) }
            appendLog(.error, "  [\(stage.name)] \(error.localizedDescription)")
            return .terminate(.error(error.localizedDescription))
        }
        var agentResult: LoopAgentResult?
        let guarded = await withScopeGuard(stage: stage, config: config, gitRoot: gitRoot,
                                           scopeGlobs: scopeGlobs) {
            agentResult = try await self.withTransportRetry(stage: stage) {
                try await self.skillExecutor.execute(
                    skillId: skillId, targetPath: stage.targetPath, message: message,
                    repoRoot: gitRoot, extraRoots: extraRoots, timeout: self.agentTimeout(for: stage))
            }
            return agentResult
        }
        let duration = Date().timeIntervalSince(startedAt)
        lastSkillResults[stage.id] = agentResult

        // The server does not run the agent when a requested skill is missing,
        // so "completed" would claim work that never happened. Fail the stage
        // and end the run: no retry can install the skill.
        if case .completed = guarded, let missing = agentResult?.unresolvedSkills, !missing.isEmpty {
            let message = Self.skillNotInstalledMessage(missing)
            stageStates[stage.id] = .failed
            appendLog(.error, "  [\(stage.name)] \(message)")
            record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                   passed: false, output: message, score: nil)
            return .terminate(.error(message))
        }

        switch guarded {
        case .failed(let error, let verdictScope, let violations, let changed):
            if Self.isCancellation(error) {
                stageStates[stage.id] = .pending
                record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                       passed: false, output: error.localizedDescription, score: nil,
                       changedPaths: changed, scopeVerdict: verdictScope)
                return .terminate(.aborted)
            }
            // ERRORED, not failed: the agent never ran (or never answered). The
            // stage still proceeds (a later iteration may retry it cleanly), but
            // `honestVerdict` ends the run `.error` unless this stage later ran
            // cleanly — a passing verify stage does not launder a dead backend.
            stageStates[stage.id] = .errored
            record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                   passed: false, output: error.localizedDescription, score: nil,
                   changedPaths: changed, scopeVerdict: verdictScope, errored: true)
            appendLog(.error, "  [\(stage.name)] skill errored: \(error.localizedDescription)")
            // Edits made before the error are still edits: a protected-path
            // violation on the throw path ends the run exactly as on success.
            if let terminal = scopeTermination(stage: stage, config: config,
                                              verdict: verdictScope, violations: violations) {
                return .terminate(terminal)
            }
            return .proceed
        case .completed(let verdictScope, let violations, let changed):
            // A run that "completed" can still have done nothing it was asked
            // to: cut off (error_max_turns, …), briefed with a truncated skill,
            // or refused every edit it tried. Those fail the stage.
            if let failure = agentResult.flatMap({ Self.skillRunFailure($0, guardChanged: changed) }) {
                stageStates[stage.id] = .failed
                appendLog(.error, "  [\(stage.name)] \(failure)")
                record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                       passed: false, output: failure, score: nil, changedPaths: changed,
                       scopeVerdict: verdictScope, agentNote: Self.agentRunNote(agentResult))
                if let terminal = scopeTermination(stage: stage, config: config,
                                                  verdict: verdictScope, violations: violations) {
                    return .terminate(terminal)
                }
                return .terminate(.error(failure))
            }
            appendLog(.info, "  [\(stage.name)] skill completed (generate)")
            // `passed` on a generate step means "ran without error" — but a step
            // whose edits were rejected as out-of-scope did not do its job, and
            // recording it as passed would render as a clean row directly above
            // the violation it caused in the run summary.
            // A code-applying stage whose protected-path touches were ALLOWED
            // (`effectivePolicy` promoted the loop's policy to `.warn`) did its
            // job: record it as passed, with the touched paths in its output,
            // so a successful run does not show a failed row.
            let allowed = !violations.isEmpty && stage.appliesCode
                && config.protectedPathPolicy != .warn
                && Self.effectivePolicy(for: stage, config: config) == .warn
            let clean = violations.isEmpty || allowed
            stageStates[stage.id] = clean ? .passed : .failed
            let output: String
            if violations.isEmpty {
                output = ""
            } else if allowed {
                output = "allowed protected-path edit(s), verified by the test stage: \(violations.joined(separator: ", "))"
            } else {
                output = "touched a protected or out-of-scope path(s): \(violations.joined(separator: ", "))"
            }
            record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                   passed: clean, output: output,
                   score: nil, changedPaths: changed, scopeVerdict: verdictScope)
            if let terminal = scopeTermination(stage: stage, config: config,
                                              verdict: verdictScope, violations: violations) {
                return .terminate(terminal)
            }
            return .proceed
        }
    }

    // MARK: - Protected-path guard

    /// The protected-path policy the guard applies to one guarded edit — the
    /// ONE place a stage can see a different policy from its loop's.
    ///
    /// A code-applying stage (`LoopStage.appliesCode`, i.e. Refactor Apply)
    /// legitimately rewrites the imports in tests and build config when it
    /// moves a module; `.revert` would undo only those edits and `.stop` would
    /// end the run, either way stranding a half-moved tree. For that stage a
    /// loop policy of `.revert` or `.stop` is treated as `.warn`: the edits
    /// stay, the violation is logged and journalled for Run Changes, and the
    /// run continues so the Test stage after it (always present —
    /// `lacksVerifyAfter`) verifies them. `.off` stays off and `.warn` stays
    /// warn. Every other guarded edit — including the Test stage's REPAIR,
    /// which is where "make the tests pass" by editing them would happen —
    /// keeps the loop's own policy.
    nonisolated static func effectivePolicy(for stage: LoopStage,
                                            config: LoopEngineConfig) -> ProtectedPathPolicy {
        let policy = config.protectedPathPolicy
        guard stage.appliesCode else { return policy }
        switch policy {
        case .revert, .stop: return .warn
        case .warn, .off: return policy
        }
    }

    private enum GuardedEditResult {
        /// The edit threw. The guard still ran: an agent that edited files and
        /// THEN failed (a dropped connection mid-run, a timeout) left real edits
        /// in the tree, and they get the same check and policy as a success.
        case failed(Error, RepairScopeVerdict, violations: [String], changed: [String])
        case completed(RepairScopeVerdict, violations: [String], changed: [String])
    }

    /// Runs an agent edit with the protected-path guard wrapped around it.
    ///
    /// The guard runs whether or not the edit reports success, but only when a
    /// policy other than `.off` is configured — a project that has opted out
    /// should not pay for two `git status` calls per repair.
    /// A Stop, however it surfaced. A repair or skill call is an HTTP request:
    /// cancelling the run cancels its URLSession task, which throws
    /// `URLError(.cancelled)` (wrapped by the API client as `.network`), not
    /// `CancellationError` — so a Stop mid-repair was recorded as a repair
    /// ERROR, and mid-skill the loop simply carried on (`.proceed`).
    nonisolated static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError || Task.isCancelled { return true }
        if let url = error as? URLError, url.code == .cancelled { return true }
        if case APIError.network(let inner) = error { return isCancellation(inner) }
        return false
    }

    /// A failure worth ONE retry: the request provably never reached a
    /// running agent, so re-sending it cannot run the agent twice. That is
    /// only "could not connect" — the backend was not listening
    /// (`NSURLErrorCannotConnectToHost`, `ECONNREFUSED`).
    ///
    /// Deliberately NOT retried, because the agent may already have run and
    /// edited the tree: a timeout (`NSURLErrorTimedOut`, `ETIMEDOUT`), any 5xx
    /// (a 502 `INTERNAL_ERROR` can come from mid-run; a 503 `NO_KEY` will not
    /// change on a retry; a 504 `AGENT_RUN_TIMEOUT` spent its whole budget),
    /// and a dropped connection (`NSURLErrorNetworkConnectionLost`,
    /// `ECONNRESET`) — `/kb/loop/agent-run` is one non-streaming POST, so a
    /// connection lost before the response is not evidence the agent never
    /// started. Never a Stop.
    nonisolated static func isRetryableTransport(_ error: Error) -> Bool {
        if isCancellation(error) { return false }
        guard case APIError.network(let inner) = error else { return false }
        let ns = inner as NSError
        switch ns.domain {
        case NSURLErrorDomain: return ns.code == NSURLErrorCannotConnectToHost
        case NSPOSIXErrorDomain: return ns.code == Int(ECONNREFUSED)
        default: return false
        }
    }

    /// Runs an agent call, retrying it once after `transportRetryDelay` when
    /// it fails with `isRetryableTransport`. A backend that was restarting for
    /// a moment must not end a run or error a stage.
    private func withTransportRetry<T>(stage: LoopStage,
                                       _ call: () async throws -> T) async throws -> T {
        do {
            return try await call()
        } catch let error where Self.isRetryableTransport(error) {
            appendLog(.warn, "  [\(stage.name)] transport error (\(error.localizedDescription)) — retrying once")
            if transportRetryDelay > 0 {
                try await Task.sleep(nanoseconds: UInt64(transportRetryDelay * 1_000_000_000))
            }
            return try await call()
        }
    }

    /// The run's final verdict with errored stages taken into account.
    ///
    /// A skill stage whose agent call errored used to `.proceed`, so a Plan or
    /// Docs loop (skill stages only) against a dead backend reported
    /// `.success` having done nothing. Rule: when ANY stage's LAST attempt in
    /// the run errored (skill, code-apply or generate — the agent never ran or
    /// never answered) and that stage never later ran cleanly, the run ends
    /// `.error`. A passing verify stage does NOT launder it: tests passing on
    /// an untouched tree, or an artifact check passing on files left by an
    /// earlier run, say nothing about work this run never did. An errored
    /// stage that ran cleanly in a later iteration does not block success.
    /// Statuses other than `.success` / `.givenUp` (blocked, aborted, needs
    /// approval, error) already say something more specific and are kept.
    nonisolated static func honestVerdict(_ status: LoopEngineStatus,
                                          iterations: [LoopIterationRecord]) -> LoopEngineStatus {
        switch status {
        case .success, .givenUp: break
        default: return status
        }
        // Each stage's last attempt of the run, in first-seen order.
        var order: [String] = []
        var last: [String: LoopStageAttempt] = [:]
        for attempt in iterations.flatMap(\.attempts) {
            if last[attempt.stageId] == nil { order.append(attempt.stageId) }
            last[attempt.stageId] = attempt
        }
        let unrecovered = order.compactMap { last[$0] }.filter { $0.errored == true }
        guard let first = unrecovered.first else { return status }
        let quoted = unrecovered.map { "\"\($0.stageName)\"" }.joined(separator: ", ")
        // A give-up is folded in, not lost: the reader still sees why the run
        // stopped, alongside the reason that verdict cannot be trusted.
        let givenUp: String
        if case .givenUp = status { givenUp = " — run \(status.summary)" } else { givenUp = "" }
        return .error("\(quoted) errored and never ran cleanly this run\(givenUp): \(first.outputTail.prefix(200))")
    }

    private func withScopeGuard(stage: LoopStage, config: LoopEngineConfig, gitRoot: URL,
                                scopeGlobs: [String] = [],
                                edit: () async throws -> LoopAgentResult?) async -> GuardedEditResult {
        guard Self.effectivePolicy(for: stage, config: config) != .off else {
            do { _ = try await edit() } catch { return .failed(error, .notChecked, violations: [], changed: []) }
            return .completed(.notChecked, violations: [], changed: [])
        }

        let before = await scopeGuard.snapshot(gitRoot: gitRoot, protectedGlobs: config.protectedGlobs,
                                               scopeGlobs: scopeGlobs)
        var thrown: Error?
        // What the agent says it wrote. `git status` cannot see an ignored
        // file, so the server's own list is part of the changed set too.
        var reported = AgentReportedEdits()
        do {
            if let result = try await edit() {
                reported = AgentReportedEdits(paths: Set(result.changedPaths),
                                              created: Set(result.createdPaths))
            }
        } catch { thrown = error }
        // Checked in a task of its own, which a Stop does not cancel: after a
        // Stop the edit's task is cancelled, the guard's git probes would fail
        // in it (`.indeterminate`, fail-open) and whatever the agent wrote
        // before the Stop would go unchecked and unreverted. The check runs to
        // completion; the cancellation still propagates from `thrown`.
        let checked = await Task { @MainActor in
            await self.checkScope(since: before, stage: stage, config: config,
                                  gitRoot: gitRoot, scopeGlobs: scopeGlobs, reported: reported)
        }.value
        guard let thrown else { return checked }
        // A client abort does not stop the server-side agent at once: a write
        // can land just AFTER the throw. Check once more after a short pause
        // (non-cancellable — a Stop must not skip it) and union both results.
        let late = await Task { @MainActor in
            try? await Task.sleep(nanoseconds: self.postThrowRecheckNanos)
            return await self.checkScope(since: before, stage: stage, config: config,
                                         gitRoot: gitRoot, scopeGlobs: scopeGlobs, reported: reported)
        }.value
        switch (checked, late) {
        case (.completed(let v1, let viol1, let ch1), .completed(let v2, let viol2, let ch2)):
            return .failed(thrown, Self.worseVerdict(v1, v2),
                           violations: Array(Set(viol1).union(viol2)).sorted(),
                           changed: Array(Set(ch1).union(ch2)).sorted())
        case (.completed(let verdict, let violations, let changed), .failed):
            return .failed(thrown, verdict, violations: violations, changed: changed)
        case (.failed, _):
            return checked
        }
    }

    /// Pause before the post-throw re-check (see `withScopeGuard`).
    var postThrowRecheckNanos: UInt64 = 500_000_000

    private static func worseVerdict(_ a: RepairScopeVerdict, _ b: RepairScopeVerdict) -> RepairScopeVerdict {
        func rank(_ v: RepairScopeVerdict) -> Int {
            switch v {
            case .notChecked: return 0
            case .clean: return 1
            case .indeterminate: return 2
            case .violatedReverted: return 3
            case .violated: return 4
            }
        }
        return rank(b) > rank(a) ? b : a
    }

    /// What an agent run said it wrote (repo-relative), and which of those
    /// files it created. `git status` cannot see an ignored file, so a write
    /// there is only visible through this list.
    struct AgentReportedEdits {
        var paths: Set<String> = []
        var created: Set<String> = []
    }

    /// The check-and-handle half of `withScopeGuard`, run after the edit
    /// whether it returned or threw.
    private func checkScope(since before: RepairScopeSnapshot, stage: LoopStage,
                            config: LoopEngineConfig, gitRoot: URL,
                            scopeGlobs: [String],
                            reported: AgentReportedEdits = AgentReportedEdits()) async -> GuardedEditResult {
        switch await scopeGuard.check(since: before, gitRoot: gitRoot,
                                      protectedGlobs: config.protectedGlobs) {
        case .clean(let changed):
            return await judge(gitChanged: changed, gitViolations: [], reported: reported, stage: stage,
                               config: config, gitRoot: gitRoot, scopeGlobs: scopeGlobs, before: before)

        case .indeterminate(let reason):
            // Fail-open, and say so. Refusing to run the loop wherever git cannot
            // report (a non-git project, a missing binary) would take the feature
            // away from those projects entirely — a worse outcome than an
            // unverified repair, which is what every run did before this guard
            // existed. The verdict is recorded as `.indeterminate`, never
            // `.clean`, so a journal reader is not told a check passed when it
            // never ran. The agent's own list of writes is still judged.
            appendLog(.warn, "  [\(stage.name)] protected-path check could not run: \(reason)")
            let paths = reported.paths.sorted()
            let hits = Self.violatingPaths(paths, protectedGlobs: config.protectedGlobs, scopeGlobs: scopeGlobs)
            guard !hits.isEmpty else { return .completed(.indeterminate, violations: [], changed: paths) }
            // Blocked, not reverted: with no usable snapshot there is no way to
            // tell the agent's edit from uncommitted work that was there first.
            appendLog(.error, "  [\(stage.name)] the agent reported editing protected/out-of-scope path(s): "
                      + hits.joined(separator: ", "))
            return .completed(.violated, violations: hits, changed: paths)

        case .unverifiable(let reason):
            // Fail-CLOSED: the check ran but saw an incomplete list, so a
            // protected edit could be hidden. Blocked like a violation; nothing
            // is reverted, since which paths to revert is exactly what is unknown.
            appendLog(.error, "  [\(stage.name)] protected-path check incomplete: \(reason)")
            return .completed(.violated, violations: ["(unverifiable: \(reason))"], changed: [])

        case .violated(let paths, let changed):
            return await judge(gitChanged: changed, gitViolations: paths, reported: reported, stage: stage,
                               config: config, gitRoot: gitRoot, scopeGlobs: scopeGlobs, before: before)
        }
    }

    /// Merges git's view of an edit with the agent's reported writes and
    /// applies the policy. A reported path git did not list (typically an
    /// ignored file) that was not dirty before is the agent's edit too, and is
    /// matched against the protected and scope globs like any other.
    private func judge(gitChanged: [String], gitViolations: [String], reported: AgentReportedEdits,
                       stage: LoopStage, config: LoopEngineConfig, gitRoot: URL,
                       scopeGlobs: [String], before: RepairScopeSnapshot) async -> GuardedEditResult {
        let gitSet = Set(gitChanged)
        let unlisted = reported.paths.subtracting(gitSet).subtracting(before.dirtyPaths)
        let merged = gitSet.union(unlisted).sorted()
        let unlistedHits = Self.violatingPaths(unlisted.sorted(), protectedGlobs: config.protectedGlobs,
                                               scopeGlobs: [])
        let violations = Set(gitViolations).union(unlistedHits)
            .union(Self.outOfScopePaths(merged, scopeGlobs: scopeGlobs)).sorted()
        guard !violations.isEmpty else { return .completed(.clean, violations: [], changed: merged) }
        return await handleViolation(violations, changed: merged, stage: stage, config: config,
                                     gitRoot: gitRoot, before: before,
                                     unlisted: unlisted, created: reported.created)
    }

    /// `paths` that match a protected glob or fall outside the scope allowlist.
    private static func violatingPaths(_ paths: [String], protectedGlobs: [String],
                                       scopeGlobs: [String]) -> [String] {
        let outOfScope = Set(outOfScopePaths(paths, scopeGlobs: scopeGlobs))
        return paths.filter { path in
            outOfScope.contains(path) || protectedGlobs.contains { GlobMatch.matches(path: path, pattern: $0) }
        }
    }

    /// `changed` paths that match none of `scopeGlobs` — `[]` whenever
    /// `scopeGlobs` is empty, so an unset allowlist (every loop before this
    /// feature, and any loop that never sets one) flags nothing.
    private static func outOfScopePaths(_ changed: [String], scopeGlobs: [String]) -> [String] {
        // Blank entries (e.g. a scope row added but not yet typed into) are
        // ignored rather than treated as a wildcard — GlobMatch.matches returns
        // true for an empty pattern, so without this filter a single blank row
        // would silently disable every OTHER real glob in the list too.
        let globs = scopeGlobs.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard !globs.isEmpty else { return [] }
        return changed.filter { path in
            !globs.contains { GlobMatch.matches(path: path, pattern: $0) }
        }
    }

    /// Shared violation handling for both a denylist hit and an out-of-scope
    /// change — logs, and under `.revert` attempts to undo exactly `paths`.
    /// Factored out of the old inline `.violated` branch so the scope-allowlist
    /// path (which can reach a violation from a `.clean` scope-guard result)
    /// gets identical policy handling instead of a second copy of it.
    /// `unlisted` are paths only the agent reported (git did not list them —
    /// ignored files): they are restored from HEAD when tracked there, else
    /// deleted only when the agent CREATED them (`created`), never a file that
    /// existed before the edit.
    private func handleViolation(_ paths: [String], changed: [String], stage: LoopStage,
                                 config: LoopEngineConfig, gitRoot: URL,
                                 before: RepairScopeSnapshot,
                                 unlisted: Set<String> = [],
                                 created: Set<String> = []) async -> GuardedEditResult {
        appendLog(.error, "  [\(stage.name)] repair edited protected/out-of-scope path(s): \(paths.joined(separator: ", "))")
        guard Self.effectivePolicy(for: stage, config: config) == .revert else {
            return .completed(.violated, violations: paths, changed: changed)
        }
        // A path that was already dirty before the edit cannot be reverted:
        // `git checkout --` restores the COMMITTED version, which would throw
        // away the uncommitted edits that were there first (often the user's
        // own). Those are left in place and the verdict stays `.violated` —
        // the run is still blocked — so nothing is silently discarded.
        let preDirty = paths.filter { before.dirtyPaths.contains($0) }
        let revertable = paths.filter { !before.dirtyPaths.contains($0) }
        if !preDirty.isEmpty {
            appendLog(.warn, "  [\(stage.name)] not reverting already-modified path(s), to keep their earlier uncommitted edits: \(preDirty.joined(separator: ", "))")
        }
        guard !revertable.isEmpty else {
            return .completed(.violated, violations: paths, changed: changed)
        }
        var errors: [String] = []
        let listed = revertable.filter { !unlisted.contains($0) }
        let unlistedRevertable = revertable.filter { unlisted.contains($0) }
        if !listed.isEmpty, let error = await scopeGuard.revert(paths: listed, gitRoot: gitRoot) {
            errors.append(error)
        }
        if !unlistedRevertable.isEmpty,
           let error = await scopeGuard.revertUnlisted(paths: unlistedRevertable, created: created,
                                                       before: before, gitRoot: gitRoot) {
            errors.append(error)
        }
        if !errors.isEmpty {
            appendLog(.error, "  [\(stage.name)] could not revert protected/out-of-scope path(s): \(errors.joined(separator: "; "))")
            return .completed(.violated, violations: paths, changed: changed)
        }
        appendLog(.info, "  [\(stage.name)] reverted \(revertable.count) protected/out-of-scope path(s)")
        return .completed(preDirty.isEmpty ? .violatedReverted : .violated,
                          violations: paths, changed: changed)
    }

    /// The terminal status a scope verdict forces, or `nil` to keep looping.
    ///
    /// This is the load-bearing half of the anti-reward-hacking guard: detecting
    /// the violation is useless if the loop then re-runs the stage, observes the
    /// exit 0 the violation bought, and reports `.success`. Under `.revert` and
    /// `.stop` the run ends here and the stage is never re-verified.
    private func scopeTermination(stage: LoopStage, config: LoopEngineConfig,
                                  verdict: RepairScopeVerdict,
                                  violations: [String]) -> LoopEngineStatus? {
        guard verdict == .violated || verdict == .violatedReverted else { return nil }
        switch Self.effectivePolicy(for: stage, config: config) {
        case .revert, .stop:
            return .blocked(reason: .repairOutOfScope(stageName: stage.name, paths: violations))
        case .warn where config.protectedPathPolicy != .warn:
            appendLog(.warn, "  [\(stage.name)] protected-path edit(s) kept for a code-applying stage "
                      + "(the test stage after it verifies them)")
            return nil
        case .warn:
            appendLog(.warn, "  [\(stage.name)] protected-path violation left in place (policy: warn)")
            return nil
        case .off:
            return nil
        }
    }

    // MARK: - Attempt ledger

    /// Builds the ledger entry for a finished repair from a tree-to-tree diff
    /// (working tree before vs after, via throwaway indexes): it sees re-edits of
    /// already-dirty files and new untracked files, and never the user's own
    /// earlier edits. Secret and protected paths are listed but never quoted.
    /// Falls back to the guard's changed paths (no diff) when git cannot say.
    private func makeLedgerEntry(n: Int, changed: [String], reply: String, failureSet: String,
                                 config: LoopEngineConfig, gitRoot: URL,
                                 treeBefore: String?) async -> LoopLedgerEntry {
        var summary: RepairDiffSummary?
        if let treeBefore, let treeAfter = await scopeGuard.snapshotTree(gitRoot: gitRoot) {
            summary = await scopeGuard.treeDiff(
                from: treeBefore, to: treeAfter, gitRoot: gitRoot, maxChars: LoopLedgerEntry.maxDiffChars,
                isQuotable: { !LoopAttemptLedger.isUnquotable($0, protectedGlobs: config.protectedGlobs) })
        }
        return LoopLedgerEntry(n: n, changedPaths: summary?.changedPaths ?? changed,
                               diffStat: summary?.stat ?? "", diff: summary?.diff ?? "",
                               replySummary: reply, failureSetBefore: failureSet.isEmpty ? nil : failureSet)
    }

    /// Records what the stage's next verification said about its last repair,
    /// both in the in-run ledger and on the journalled attempt that carries it.
    private func settleLedger(stageId: String, passed: Bool, failureSet: String) {
        if attemptLedgers[stageId]?.last?.isSettled == false {
            emit(LoopRunEvent(kind: LoopRunEvent.Kind.ledgerSettled, iteration: iteration, stageId: stageId,
                              detail: passed ? "passed" : failureSet))
        }
        if let i = attemptLedgers[stageId]?.indices.last, attemptLedgers[stageId]![i].isSettled == false {
            if passed { attemptLedgers[stageId]![i].resultingPassed = true }
            else { attemptLedgers[stageId]![i].resultingFailureSet = failureSet }
        }
        for r in iterationRecords.indices.reversed() {
            guard let a = iterationRecords[r].attempts.lastIndex(where: {
                $0.stageId == stageId && $0.ledger != nil }) else { continue }
            if iterationRecords[r].attempts[a].ledger?.isSettled == false {
                if passed { iterationRecords[r].attempts[a].ledger?.resultingPassed = true }
                else { iterationRecords[r].attempts[a].ledger?.resultingFailureSet = failureSet }
            }
            return
        }
    }

    /// The previous run's last repairs for `stageId`, when that run ended on
    /// this same failure set. Read off the main actor, once per stage per run.
    private func priorRunLedger(stageId: String, failureSet: String) async -> [LoopLedgerEntry] {
        guard let ctx = currentRunContext, !failureSet.isEmpty else { return [] }
        return await journal.priorRunLedger(root: ctx.faultsRoot, loopId: ctx.loopId,
                                            excludingRunId: ctx.runId, stageId: stageId, failureSet: failureSet)
    }

    // MARK: - Journal

    /// Appends one stage attempt to the current iteration's record. A stage that
    /// runs outside any iteration (there is none today) is dropped rather than
    /// crashing on an empty array.
    private func record(_ stage: LoopStage, startedAt: Date, duration: Double,
                        exitCode: Int32?, passed: Bool, output: String,
                        outputHash: String? = nil, score: Int?,
                        repairAttempted: Bool = false,
                        repairDuration: Double? = nil, repairIndex: Int? = nil,
                        changedPaths: [String] = [],
                        scopeVerdict: RepairScopeVerdict = .notChecked,
                        errored: Bool = false, agentNote: String? = nil,
                        ledger: LoopLedgerEntry? = nil, flaky: Bool? = nil) {
        guard !iterationRecords.isEmpty else { return }
        let attempt = LoopStageAttempt(
                stageId: stage.id, stageName: stage.name, kind: stage.kind,
                severity: stage.severity, startedAt: startedAt, durationSeconds: duration,
                exitCode: exitCode, passed: passed, outputTail: output,
                outputHash: passed ? nil : (outputHash ?? Self.hash(output)), score: score,
                repairAttempted: repairAttempted,
                repairDurationSeconds: repairDuration, repairAttemptIndex: repairIndex,
                changedPaths: changedPaths,
                scopeVerdict: scopeVerdict,
                errored: errored ? true : nil, agentNote: agentNote, ledger: ledger, flaky: flaky)
        iterationRecords[iterationRecords.count - 1].attempts.append(attempt)
        emit(LoopRunEvent(kind: LoopRunEvent.Kind.stageFinished, iteration: iteration,
                          stageId: stage.id, stageName: stage.name, attempt: attempt))
    }

    /// Appends to the current run's crash-safe event log (no-op between runs).
    private func emit(_ event: LoopRunEvent) {
        guard let ctx = currentRunContext else { return }
        journal.appendEvent(event, runId: ctx.runId, root: ctx.faultsRoot)
    }

    /// Sets the terminal status, logs it, writes the journal entry, and returns
    /// the status. Every exit from `run` goes through here so no path can end a
    /// run without journalling it.
    private func finish(_ terminal: LoopEngineStatus, config: LoopEngineConfig,
                        faultsRoot: URL, gitRoot: URL, projectId: String?,
                        startedAt: Date, loopId: String, loopName: String) async -> LoopEngineStatus {
        if case .error(let message) = terminal {
            IncidentRecorder.record(source: .ui, category: "loop", message: message)
        }
        if let token = selfHealSuppression {
            IncidentRecorder.endSuppression(token)
            selfHealSuppression = nil
        }
        if let batch = selfHealBatch {
            selfHealBatch = nil
            await writeBackSelfHeal(batch: batch, terminal: terminal, gitRoot: gitRoot)
        }
        status = terminal
        appendLog(logLevel(for: terminal), "Loop finished · \(terminal.summary)")

        emit(LoopRunEvent(kind: LoopRunEvent.Kind.verdict, detail: terminal.summary,
                          statusCode: terminal.code))
        let record = LoopRunRecord(
            id: currentRunContext?.runId ?? UUID().uuidString, projectId: projectId, trigger: trigger,
            gitRoot: gitRoot.path, startedAt: startedAt, endedAt: Date(),
            iterationsUsed: iteration, config: LoopRunConfigSnapshot(config),
            iterations: iterationRecords, statusCode: terminal.code,
            statusSummary: terminal.summary, loopId: loopId, loopName: loopName)
        // Fail-open: telemetry never gates the work it observes.
        if let reason = journal.write(record, root: faultsRoot) {
            appendLog(.warn, "Run journal not written: \(reason)")
        }
        // Opt-in human-readable counterpart, same fail-open contract. Written
        // after the journal so the machine record exists even if note indexing
        // (which touches more moving parts) fails.
        if config.writeSummaryNote {
            switch await summaryWriter.write(record, root: faultsRoot) {
            case .written(let path):
                appendLog(.info, "Run summary note written: \(path)")
            case .failed(let reason):
                appendLog(.warn, "Run summary note not written: \(reason)")
            }
        }
        return terminal
    }

    /// Reads back the fix agent's verdicts and updates each batched incident
    /// accordingly, then removes the `.self-heal` scratch directory so it
    /// does not linger in the (worktree or main) checkout across runs.
    private func writeBackSelfHeal(batch: [Incident], terminal: LoopEngineStatus, gitRoot: URL) async {
        let batchFile = gitRoot.appendingPathComponent(SelfHealBatch.relativePath)
        let markdown = (try? String(contentsOf: batchFile, encoding: .utf8)) ?? ""
        var succeeded = false
        var errored = false
        switch terminal {
        case .success: succeeded = true
        case .error: errored = true
        default: break
        }
        let agentDown = errored && stageStates.values.contains(.errored)
        let aborted = terminal == .aborted
        let proposal = currentWorktreeLease.map {
            IncidentProposal(mainRepo: $0.mainRepo.path, worktreePath: $0.worktreePath.path,
                             branch: $0.branch, baseCommit: $0.baseCommit)
        }
        let proposed = SelfHealOutcome.apply(batch: batch, results: SelfHealBatch.parseResults(markdown),
                                             runSucceeded: succeeded, agentDown: agentDown, runAborted: aborted,
                                             proposal: proposal, store: .shared)
        try? FileManager.default.removeItem(at: batchFile.deletingLastPathComponent())
        appendLog(.info, "Self-Heal · \(proposed) fix(es) proposed from \(batch.count) incident(s)")
        // Borrowed symlinks keep a no-fix worktree "dirty"; remove it here so it is not retained.
        // `discard` shells out to `git worktree remove` on a full checkout —
        // seconds, not milliseconds — so it must not block this @MainActor method.
        if proposed == 0, let proposal {
            let proposalCopy = proposal
            _ = await Task.detached { try? SelfHealProposalService.discard(proposalCopy) }.value
        }
    }

    // MARK: - Helpers

    /// The most severe of several guard verdicts (the sweep runs one guarded
    /// repair per failing fault): violated > reverted > indeterminate > clean
    /// > not checked.
    nonisolated static func worstVerdict(_ verdicts: [RepairScopeVerdict]) -> RepairScopeVerdict {
        let rank: [RepairScopeVerdict] = [.violated, .violatedReverted, .indeterminate, .clean]
        return rank.first(where: verdicts.contains) ?? .notChecked
    }

    /// One-line, human-readable regression-sweep result for the run log:
    /// either "passed — M of T" or "failed — R regressed / M passed of T".
    /// M = faults that still hold (.unchanged + .repaired).
    private static func regressionLine(_ outcome: SweepOutcome) -> String {
        let passedCount = outcome.unchanged + outcome.repaired
        if outcome.passed {
            return "passed — \(passedCount) of \(outcome.total)"
        }
        var parts = ["\(outcome.regressed) regressed"]
        if outcome.repairFailed > 0 { parts.append("\(outcome.repairFailed) repair failed") }
        if outcome.needsApproval > 0 { parts.append("\(outcome.needsApproval) need approval") }
        if outcome.failed > 0 { parts.append("\(outcome.failed) could not run") }
        if outcome.pending > 0 { parts.append("\(outcome.pending) not reached") }
        return "failed — \(outcome.failingCount) failing (\(parts.joined(separator: ", "))) / \(passedCount) passed of \(outcome.total)"
    }

    /// Default agent message for a `.skill` stage with no user-written prompt:
    /// names the stage and, if set, the target source the skill is scoped to.
    /// The custom prompt when set, else a built-in default — either way with
    /// the input/output paths appended, so a user's own prompt text doesn't
    /// silently drop what they picked in the Input/Output fields. Both are
    /// text hints for the skill's own tool calls, not a mechanical redirect —
    /// the runner never reads or writes either path itself.
    static func composeSkillMessage(_ stage: LoopStage, paths: LoopStagePaths? = nil) -> String {
        var msg = (stage.prompt?.isEmpty == false)
            ? stage.prompt!
            : "Apply the skill for stage \"\(stage.name)\"."
        if let target = stage.targetPath, !target.isEmpty {
            msg += " Input: \(Self.describePath(target, absolute: paths?.input))."
        }
        if let output = stage.outputPath, !output.isEmpty {
            msg += " Write output to: \(Self.describePath(output, absolute: paths?.output))."
        }
        return msg
    }

    /// `PathUtils.relative` returns "." for the repo (git) root itself — stage
    /// paths are relative to the git root, not the project root — read
    /// naturally in a sentence ("Input: .." reads as a typo/ambiguous
    /// double-dot, not "the repo root").
    private static func describePath(_ path: String, absolute: URL? = nil) -> String {
        let shown = path == "." ? "the repo root" : path
        guard let absolute, absolute.path != path else { return shown }
        return "\(absolute.path) (\(shown))"
    }

    /// Prefixes `goal`/`acceptanceCriteria` (when either is set) onto text the
    /// repair agent or a skill stage will see, so a loop's "done" signal is
    /// more than "the command exited 0". Returns `text` unchanged when both
    /// are `nil`/empty — every loop before this feature, and every migrated
    /// loop that never sets them, sees byte-identical prompts to before.
    ///
    /// - Parameter reservedForTruncation: when the caller's own downstream
    ///   template truncates the combined string FROM THE TAIL (as
    ///   `AgentLoopStageRepairer.buildPrompt` does via
    ///   `.suffix(maxFailureOutputChars)` on `failureOutput`), a header placed
    ///   at the FRONT of that string would otherwise be pushed entirely out of
    ///   the kept window once `text` alone reaches that size — silently
    ///   dropping the goal/acceptance context on exactly the large, ambiguous
    ///   failures this feature exists to help with. Pass the downstream
    ///   truncation budget here so `text` is trimmed to leave room for the
    ///   header BEFORE that truncation ever runs. `nil` (the skill-message
    ///   path, which has no downstream truncation) skips this entirely.
    private static func prependGoalContext(_ text: String, goal: String?, acceptanceCriteria: String?,
                                           reservedForTruncation: Int? = nil) -> String {
        var lines: [String] = []
        if let goal, !goal.isEmpty { lines.append("Goal: \(goal)") }
        if let acceptanceCriteria, !acceptanceCriteria.isEmpty {
            lines.append("Acceptance criteria: \(acceptanceCriteria)")
        }
        guard !lines.isEmpty else { return text }
        let header = lines.joined(separator: "\n") + "\n\n"
        guard let budget = reservedForTruncation else { return header + text }
        let remaining = budget - header.count
        let trimmedText = remaining > 0 ? String(text.suffix(remaining)) : ""
        return header + trimmedText
    }

    /// Ceiling for the in-memory live log. Runners are app-lifetime now
    /// (owned by `LoopRunService`), so an unbounded log would accumulate for
    /// as long as the app stays open. Mirrors `TaskLogStore`'s own cap.
    private static let maxLogLines = 2000

    private func appendLog(_ level: LoopLogLine.Level, _ text: String) {
        let line = LoopLogLine(at: Date(), level: level, text: text)
        log.append(line)
        if log.count > Self.maxLogLines {
            // Trim in one chunk, not per append — removeFirst(1) per line
            // would make every append past the cap O(n).
            log.removeFirst(log.count - Self.maxLogLines + Self.maxLogLines / 10)
        }
        onLog?(line)
    }

    /// A config problem with a stage command, in the two lengths the app
    /// needs it.
    ///
    /// `status` becomes `LoopEngineStatus.error`'s payload, and that string
    /// is NOT log text: it is the journal's `statusSummary`, the run-summary
    /// note's TITLE, a notification body, and a row in both the desktop and
    /// phone run lists (where it wraps rather than truncates). Every other
    /// terminal status is a handful of words, so a paragraph here would push
    /// the other runs off a 320pt pane and produce a 200-character note
    /// title. The explanation goes in `detail`, which is logged once — one
    /// line above, where the user is already looking.
    private struct CommandProblem {
        let status: String
        let detail: String
    }

    /// Why `stage`'s command cannot be run, or `nil` when it can be.
    ///
    /// The multi-line rule is a correctness gate, not tidiness. `sh -c`
    /// treats a newline as a command SEPARATOR and yields only the last
    /// line's exit code, so `swift build⏎swift test` runs both and reports
    /// the tests' status: the build fails, the tests pass against a stale
    /// binary, and the stage goes green on a repo that does not compile. A
    /// verification harness that can be made to pass by a failing first line
    /// is not a verification harness.
    ///
    /// Enforced HERE rather than in the editor because the editor is not the
    /// only writer: a single-line `TextField` still accepts a pasted newline
    /// (measured — AppKit's field editor does not filter them), and
    /// `system/loop.json` can be hand-edited or arrive from a template.
    /// Preflight is the one place every route passes through.
    private static func commandProblem(_ stage: LoopStage) -> CommandProblem? {
        guard let command = stage.command,
              !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            let message = "Stage \"\(stage.name)\" has no command"
            return CommandProblem(status: message, detail: message)
        }
        // `\.isNewline`, not just "\n": a CRLF paste would otherwise leave a
        // trailing \r that `sh` reads as part of the last word, and the
        // Unicode line separators corrupt the command just as thoroughly.
        guard !command.contains(where: \.isNewline) else {
            return CommandProblem(
                status: "Stage \"\(stage.name)\" has a multi-line command — see the log",
                detail: "Stage \"\(stage.name)\" has a multi-line command. `sh -c` reports only the last line's exit code, so a failing first line would pass silently — chain the steps with `&&` on one line instead.")
        }
        return nil
    }

    /// Returns the stage's command when it is runnable; nil otherwise. One
    /// rule, shared with `commandProblem` above, so the preflight message and
    /// the runtime guard can never disagree about what is runnable.
    private static func validCommand(_ stage: LoopStage) -> String? {
        guard commandProblem(stage) == nil else { return nil }
        return stage.command
    }

    /// Failure count and, for a failure (`hashing`), the stall-detector hash
    /// and first error lines of a shell stage's output — on a background
    /// executor, never the main actor.
    nonisolated private static func analyse(_ output: String,
                                            hashing: Bool) async
        -> (score: Int?, hash: String, errorLines: String, ids: Set<String>) {
        await Task.detached(priority: .utility) {
            (hashing ? StageOutputParser.failureScore(output) : StageOutputParser.parseFailureCount(output),
             hashing ? (TestFailureExtractor.failureSetHash(output) ?? hash(output)) : "",
             hashing ? StageOutputParser.firstErrorLines(output) : "",
             hashing ? Set(TestFailureExtractor.extract(output).ids) : [])
        }.value
    }

    /// Hashes failure output after stripping duration-shaped and hex
    /// tokens, so elapsed-time noise (e.g. `swift test`'s `"Executed 5
    /// tests ... in 0.003 (0.005) seconds"`) doesn't make an otherwise-
    /// identical failure register as "new" every iteration and silently
    /// defeat `consecutiveFailureStop`.
    ///
    /// Deliberately NOT a blanket "strip every digit" — that would also
    /// erase the failure COUNT itself (`"9 tests, 3 failures"` vs `"9
    /// tests, 1 failure"` is a real, shrinking-toward-fixed difference,
    /// not noise), integer line numbers (`Foo.swift:42` vs `:118`), and
    /// integer assertion values (`("3")` vs `("7")`) — those must keep
    /// hashing differently so genuine progress or a genuinely different
    /// failure is never mistaken for a repeat. Only three narrow,
    /// unambiguously noisy shapes are normalized: decimal durations,
    /// unit-suffixed durations, and hex addresses/ids.
    ///
    /// This is an accepted tradeoff, not a fully solved problem: a
    /// FLOAT or hex assertion value (e.g. `"expected 1.5 got 2.5"` vs
    /// `"expected 1.5 got 9.75"`) still collapses to the same hash,
    /// since these regexes can't distinguish "a duration" from "a float
    /// assertion value" without more context than a bare string offers.
    /// `StageOutputParser`'s score is the primary progress signal precisely
    /// because it does not share this weakness; the hash is the fallback for
    /// runners whose output it does not recognise.
    nonisolated private static func hash(_ s: String) -> String {
        var normalized = s.replacingOccurrences(
            of: #"\d+\.\d+"#, with: "#", options: .regularExpression)
        normalized = normalized.replacingOccurrences(
            of: #"\b\d+\s*(ms|µs|ns|s|sec|seconds?)\b"#, with: "#", options: .regularExpression)
        normalized = normalized.replacingOccurrences(
            of: #"0x[0-9a-fA-F]+"#, with: "#", options: .regularExpression)
        let digest = SHA256.hash(data: Data(normalized.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func logLevel(for status: LoopEngineStatus) -> LoopLogLine.Level {
        if case .success = status { return .info }
        return .error
    }
}

// The protocol was written FROM this type's existing members (see
// Core/Contracts/LoopRunning.swift), so conformance is a one-liner. If this
// stops compiling after an unrelated change to `run`'s signature, fix the
// protocol to match — never change `run` to satisfy a signature the seam
// guessed at.
extension LoopEngineRunner: LoopRunning {}

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
    struct LogLine: Identifiable, Equatable {
        enum Level: Equatable { case info, warn, error }
        let id = UUID()
        let at: Date
        let level: Level
        let text: String
    }

    @Published private(set) var running = false
    @Published private(set) var log: [LogLine] = []
    @Published private(set) var status: LoopEngineStatus?
    @Published private(set) var iteration = 0

    /// Optional mirror for every log line this runner emits, so a surface that
    /// does not own the runner can still follow a run.
    ///
    /// `log` above is instance state on a `@StateObject`, which means it is
    /// reachable only from the view that owns it. Nothing else — the Auto Tasks
    /// page, the activity feed, the iPhone — could see progress WITHIN a run;
    /// they got the terminal outcome and nothing else. A sink at the single
    /// append site is enough to fix that without moving any ownership.
    var onLog: ((LogLine) -> Void)?

    /// Process-wide set of git roots with a run currently in flight,
    /// keyed by symlink-resolved filesystem path. Guards against two
    /// *different* `LoopEngineRunner` instances (e.g. a chat-triggered
    /// run and a scheduled Auto Task run — the design spec explicitly
    /// promises these are rejected the same way) racing on the same
    /// working tree. The instance-scoped `running` flag alone can't
    /// catch that, since each caller constructs its own runner instance.
    @MainActor private static var activeRoots: Set<String> = []

    /// Whether ANY runner instance is mid-run on `gitRoot`, resolved the same
    /// way `activeRoots` keys it. Read-only view of the guard above, for
    /// callers that need to report on a run they do not own — the mobile
    /// bridge asks this so the phone can never show "idle" while the desktop
    /// is mid-run, without either side having to share a runner instance.
    @MainActor
    static func isRunActive(gitRoot: URL) -> Bool {
        activeRoots.contains(gitRoot.resolvingSymlinksInPath().path)
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
    private let journal: LoopRunJournaling
    private let summaryWriter: LoopRunSummaryWriting
    private let scopeGuard: RepairScopeGuarding
    private let trigger: LoopRunTrigger

    /// Accumulated journal state for the in-flight run. Instance state rather
    /// than a `run`-local `var` only because the per-stage helpers below append
    /// to it; `@MainActor` makes that safe.
    private var iterationRecords: [LoopIterationRecord] = []

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
         trigger: LoopRunTrigger = .manual) {
        self.verifier = verifier
        self.stageRepairer = stageRepairer
        self.regressionSweep = regressionSweep
        self.skillExecutor = skillExecutor
        self.approvals = approvals
        self.stageTimeout = stageTimeout
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
            id: UUID().uuidString, projectId: ctx.projectId, trigger: trigger,
            gitRoot: ctx.gitRoot.path, startedAt: ctx.startedAt, endedAt: Date(),
            iterationsUsed: iteration, config: LoopRunConfigSnapshot(ctx.config),
            iterations: iterationRecords, statusCode: LoopEngineStatus.aborted.code,
            statusSummary: LoopEngineStatus.aborted.summary)
        _ = journal.write(record, root: ctx.faultsRoot)
    }

    func clearLog() { log.removeAll() }

    /// What the loop should do after one stage finished.
    private enum StageDecision: Equatable {
        /// Move on to the next stage — the stage passed, or it failed but is
        /// `.advisory` and therefore does not gate.
        case proceed
        /// A blocking stage failed and was handled (repaired or not); restart the
        /// iteration from the first stage.
        case retryIteration
        /// End the run with this status.
        case terminate(LoopEngineStatus)
    }

    /// Runs `config`'s ordered stages to completion, success, or give-up.
    ///
    /// Returns `nil` when the run never started at all — either this
    /// instance is already mid-run, or another `LoopEngineRunner`
    /// instance is already running against the same `gitRoot`. Callers
    /// (e.g. the chat command and the Auto Task scheduler) MUST check
    /// for `nil` rather than assume every call produced a real status:
    /// `status` is only meaningful when this returns non-nil — on a
    /// `nil` return, `status` still holds whatever a PREVIOUS run on
    /// this instance left behind (or `nil` if there was none), since a
    /// rejected call doesn't touch it. The rejection is still recorded
    /// to `log`, which is never cleared automatically.
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
    @discardableResult
    func run(config: LoopEngineConfig, faultsRoot: URL, gitRoot: URL,
             projectId: String? = nil) async -> LoopEngineStatus? {
        guard !running else {
            appendLog(.warn, "Loop not started · this runner instance is already running")
            return nil
        }
        // Resolve symlinks (not just `standardizedFileURL`, which only
        // normalizes path components like "." and ".." — it does NOT
        // resolve symlinks that exist on disk, e.g. a symlinked worktree,
        // or collapse APFS case-insensitivity/firmlink aliasing) so two
        // different-looking paths to the SAME actual directory can't both
        // be admitted as "different" roots and race each other. This only
        // helps for paths that actually exist; two non-existent paths can
        // still alias, but a real `gitRoot` always exists on disk.
        let rootKey = gitRoot.resolvingSymlinksInPath().path
        guard !Self.activeRoots.contains(rootKey) else {
            appendLog(.warn, "Loop not started · a run is already in progress for this repo")
            return nil
        }
        Self.activeRoots.insert(rootKey)
        running = true
        status = nil
        iteration = 0
        iterationRecords = []
        let startedAt = Date()
        currentRunContext = RunContext(config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                       projectId: projectId, startedAt: startedAt)
        defer {
            running = false
            Self.activeRoots.remove(rootKey)
            currentRunContext = nil
        }

        // Disabled stages are skipped entirely — not run, not preflighted.
        // Preflighting them anyway would let a disabled stage's missing
        // command or approval block a run it takes no part in.
        let orderedStages = LoopStage.runOrder(config.stages.filter(\.enabled))
        let disabledCount = config.stages.count - orderedStages.count
        guard !orderedStages.isEmpty else {
            // Two different user errors, two different fixes — "enable one"
            // is nonsense advice for a config with no stages at all.
            let reason = config.stages.isEmpty
                ? "No stages configured"
                : "Every stage is disabled — enable at least one"
            appendLog(.warn, "Loop not run · \(reason)")
            return await finish(.error(reason),
                                config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                projectId: projectId, startedAt: startedAt)
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
                guard let command = Self.validCommand(stage) else {
                    return await finish(.error("Stage \"\(stage.name)\" has no command"),
                                        config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                        projectId: projectId, startedAt: startedAt)
                }
                guard approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command) else {
                    appendLog(.warn, "  [\(stage.name)] needs approval: \(command)")
                    return await finish(.needsApproval(stageName: stage.name),
                                        config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                        projectId: projectId, startedAt: startedAt)
                }
            case .skill:
                // A generate stage with no skill chosen would fire a bare
                // agent call with no skill framing at all — uncontrolled
                // edits, silently, every iteration. That is a config error
                // on par with a shell stage with no command.
                guard let skillId = stage.skillId,
                      !skillId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return await finish(.error("Stage \"\(stage.name)\" has no skill chosen"),
                                        config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                        projectId: projectId, startedAt: startedAt)
                }
            case .regressionSweep:
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
            if iteration >= 1, let budget = config.wallClockBudgetSeconds,
               Date().timeIntervalSince(startedAt) > budget {
                appendLog(.warn, "Time budget of \(Int(budget))s exceeded after \(iteration) iteration(s)")
                status = .givenUp(reason: .wallClockExceeded)
                break iterationLoop
            }

            iteration += 1
            iterationRecords.append(LoopIterationRecord(index: iteration))
            appendLog(.info, "Iteration \(iteration)/\(config.maxIterations)")

            for stage in orderedStages {
                let decision: StageDecision
                switch stage.kind {
                case .regressionSweep:
                    decision = await runRegressionStage(
                        stage, config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                        progress: &progress)
                case .shellCommand:
                    decision = await runShellStage(
                        stage, config: config, gitRoot: gitRoot,
                        progress: &progress, repairsUsed: &repairsUsed)
                case .skill:
                    decision = await runSkillStage(stage, config: config, gitRoot: gitRoot)
                }

                switch decision {
                case .proceed:
                    continue
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
        return await finish(status ?? .givenUp(reason: .maxIterations),
                            config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                            projectId: projectId, startedAt: startedAt)
    }

    // MARK: - Stage execution

    private func runRegressionStage(_ stage: LoopStage, config: LoopEngineConfig,
                                    faultsRoot: URL, gitRoot: URL,
                                    progress: inout ProgressWatch) async -> StageDecision {
        let startedAt = Date()
        let outcome = await regressionSweep.sweep(
            faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: true)
        let duration = Date().timeIntervalSince(startedAt)
        // The regressed count IS the score here — no parsing needed, which is why
        // this stage could always see progress while shell stages could not. The
        // same line is the log entry, the journal's output tail, and the hash
        // input, so it is built once.
        let line = Self.regressionLine(outcome)
        appendLog(outcome.passed ? .info : .warn, "  [\(stage.name)] \(line)")

        if outcome.passed {
            record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                   passed: true, output: "", score: 0)
            // A pass restarts the stall watch so a later failure in the same run
            // counts from scratch.
            progress.clear(key: stage.id)
            return .proceed
        }

        let verdict = progress.record(key: stage.id, score: outcome.regressed, hash: Self.hash(line))
        record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
               passed: false, output: line, score: outcome.regressed)

        if stage.severity == .advisory {
            appendLog(.warn, "  [\(stage.name)] advisory — not gating the run")
            return .proceed
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
                               repairsUsed: inout [String: Int]) async -> StageDecision {
        // Preflight already validated this once per stage; if a command somehow
        // becomes invalid by the time we get here, fail closed instead of
        // force-unwrapping.
        guard let command = Self.validCommand(stage) else {
            return .terminate(.error("Stage \"\(stage.name)\" has no command"))
        }

        let startedAt = Date()
        let timeout = stage.timeoutSeconds.map(TimeInterval.init) ?? stageTimeout
        let outcome: VerifyOutcome
        do {
            outcome = try await verifier.verify(command: command, repoRoot: gitRoot, timeout: timeout)
        } catch is CancellationError {
            return .terminate(.aborted)
        } catch VerifyError.timedOut(let seconds) {
            // A timeout means the stage never confirmed passing — treat it like an
            // ordinary non-zero-exit failure (same score/retry/repair path below),
            // not a fatal run-ending error. Only a genuine launch failure below is
            // fatal.
            outcome = VerifyOutcome(exitCode: -1, output: "stage timed out after \(seconds)s")
        } catch VerifyError.stoppedForResources(let reason) {
            // Explicitly NOT the timeout path above: a resource stop must not be
            // scored as a stage failure, because a failing stage is what triggers
            // an LLM repair — and dispatching a repair is the last thing to do
            // while the machine is already under critical memory pressure. End the
            // run and say why.
            appendLog(.warn, "  [\(stage.name)] \(reason)")
            return .terminate(.error(reason))
        } catch {
            appendLog(.error, "  [\(stage.name)] error: \(error.localizedDescription)")
            return .terminate(.error(error.localizedDescription))
        }
        let duration = Date().timeIntervalSince(startedAt)

        if outcome.exitCode == 0 {
            appendLog(.info, "  [\(stage.name)] passed")
            record(stage, startedAt: startedAt, duration: duration, exitCode: 0,
                   passed: true, output: "", score: StageOutputParser.parseFailureCount(outcome.output))
            progress.clear(key: stage.id)
            return .proceed
        }

        let score = StageOutputParser.parseFailureCount(outcome.output)
        let excerpt = String(outcome.output.suffix(500))
        let scoreNote = score.map { " · \($0) failing" } ?? ""
        appendLog(.warn, "  [\(stage.name)] FAILED (exit \(outcome.exitCode))\(scoreNote): \(excerpt)")

        let verdict = progress.record(key: stage.id, score: score, hash: Self.hash(outcome.output))

        if stage.severity == .advisory {
            appendLog(.warn, "  [\(stage.name)] advisory — not gating the run")
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, score: score)
            return .proceed
        }

        if verdict.streak >= config.consecutiveFailureStop {
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, score: score)
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
                   passed: false, output: outcome.output, score: score)
            return .terminate(.givenUp(reason: .maxIterations))
        }

        let used = repairsUsed[stage.id] ?? 0
        if used >= config.maxRepairsPerStage {
            appendLog(.warn, "  [\(stage.name)] repair budget of \(config.maxRepairsPerStage) exhausted")
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, score: score)
            return .terminate(.givenUp(reason: .repairBudgetExhausted(stageName: stage.name)))
        }

        appendLog(.info, "  [\(stage.name)] repairing…")
        repairsUsed[stage.id] = used + 1
        let evidence = RepairEvidence(
            attempt: used + 1, previousScore: verdict.previousScore, currentScore: score,
            improved: verdict.improved, streak: verdict.streak)

        let guarded = await withScopeGuard(stage: stage, config: config, gitRoot: gitRoot) {
            try await stageRepairer.repair(
                stageName: stage.name, command: command,
                failureOutput: outcome.output, evidence: evidence, repoRoot: gitRoot)
        }

        switch guarded {
        case .failed(let error):
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, score: score, repairAttempted: true)
            if error is CancellationError { return .terminate(.aborted) }
            appendLog(.error, "  [\(stage.name)] repair error: \(error.localizedDescription)")
            return .terminate(.error(error.localizedDescription))
        case .completed(let verdictScope, let violations, let changed):
            record(stage, startedAt: startedAt, duration: duration, exitCode: outcome.exitCode,
                   passed: false, output: outcome.output, score: score, repairAttempted: true,
                   changedPaths: changed, scopeVerdict: verdictScope)
            if let terminal = scopeTermination(stage: stage, config: config,
                                              verdict: verdictScope, violations: violations) {
                return .terminate(terminal)
            }
            return .retryIteration
        }
    }

    private func runSkillStage(_ stage: LoopStage, config: LoopEngineConfig,
                              gitRoot: URL) async -> StageDecision {
        let skillId = stage.skillId ?? ""
        let message = Self.composeSkillMessage(stage)
        let startedAt = Date()
        appendLog(.info, "  [\(stage.name)] running skill \(skillId.isEmpty ? "(none set)" : skillId) (generate)")

        // A skill stage is a generate step that edits the tree, so it gets the
        // same protected-path guard as a repair: "make the tests pass" is as
        // available to a skill as it is to the repairer.
        let guarded = await withScopeGuard(stage: stage, config: config, gitRoot: gitRoot) {
            try await skillExecutor.execute(skillId: skillId, targetPath: stage.targetPath, message: message)
        }
        let duration = Date().timeIntervalSince(startedAt)

        switch guarded {
        case .failed(let error):
            record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                   passed: false, output: error.localizedDescription, score: nil)
            if error is CancellationError { return .terminate(.aborted) }
            // A generate step that errors is non-fatal: log it and let the loop's
            // verify stages / iteration cap decide termination.
            appendLog(.warn, "  [\(stage.name)] skill error: \(error.localizedDescription)")
            return .proceed
        case .completed(let verdictScope, let violations, let changed):
            appendLog(.info, "  [\(stage.name)] skill completed (generate)")
            // `passed` on a generate step means "ran without error" — but a step
            // whose edits were rejected as out-of-scope did not do its job, and
            // recording it as passed would render as a clean row directly above
            // the violation it caused in the run summary.
            let clean = violations.isEmpty
            record(stage, startedAt: startedAt, duration: duration, exitCode: nil,
                   passed: clean, output: clean ? "" : "edited protected path(s): \(violations.joined(separator: ", "))",
                   score: nil, changedPaths: changed, scopeVerdict: verdictScope)
            if let terminal = scopeTermination(stage: stage, config: config,
                                              verdict: verdictScope, violations: violations) {
                return .terminate(terminal)
            }
            return .proceed
        }
    }

    // MARK: - Protected-path guard

    private enum GuardedEditResult {
        case failed(Error)
        case completed(RepairScopeVerdict, violations: [String], changed: [String])
    }

    /// Runs an agent edit with the protected-path guard wrapped around it.
    ///
    /// The guard runs whether or not the edit reports success, but only when a
    /// policy other than `.off` is configured — a project that has opted out
    /// should not pay for two `git status` calls per repair.
    private func withScopeGuard(stage: LoopStage, config: LoopEngineConfig, gitRoot: URL,
                                edit: () async throws -> Void) async -> GuardedEditResult {
        guard config.protectedPathPolicy != .off else {
            do { try await edit() } catch { return .failed(error) }
            return .completed(.notChecked, violations: [], changed: [])
        }

        let before = await scopeGuard.snapshot(gitRoot: gitRoot)
        do { try await edit() } catch { return .failed(error) }

        switch await scopeGuard.check(since: before, gitRoot: gitRoot,
                                      protectedGlobs: config.protectedGlobs) {
        case .clean(let changed):
            return .completed(.clean, violations: [], changed: changed)

        case .indeterminate(let reason):
            // Fail-open, and say so. Refusing to run the loop wherever git cannot
            // report (a non-git project, a missing binary) would take the feature
            // away from those projects entirely — a worse outcome than an
            // unverified repair, which is what every run did before this guard
            // existed. The verdict is recorded as `.indeterminate`, never
            // `.clean`, so a journal reader is not told a check passed when it
            // never ran.
            appendLog(.warn, "  [\(stage.name)] protected-path check could not run: \(reason)")
            return .completed(.indeterminate, violations: [], changed: [])

        case .violated(let paths, let changed):
            appendLog(.error, "  [\(stage.name)] repair edited protected path(s): \(paths.joined(separator: ", "))")
            guard config.protectedPathPolicy == .revert else {
                return .completed(.violated, violations: paths, changed: changed)
            }
            if let error = await scopeGuard.revert(paths: paths, gitRoot: gitRoot) {
                appendLog(.error, "  [\(stage.name)] could not revert protected path(s): \(error)")
                return .completed(.violated, violations: paths, changed: changed)
            }
            appendLog(.info, "  [\(stage.name)] reverted \(paths.count) protected path(s)")
            return .completed(.violatedReverted, violations: paths, changed: changed)
        }
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
        switch config.protectedPathPolicy {
        case .revert, .stop:
            return .blocked(reason: .repairOutOfScope(stageName: stage.name, paths: violations))
        case .warn:
            appendLog(.warn, "  [\(stage.name)] protected-path violation left in place (policy: warn)")
            return nil
        case .off:
            return nil
        }
    }

    // MARK: - Journal

    /// Appends one stage attempt to the current iteration's record. A stage that
    /// runs outside any iteration (there is none today) is dropped rather than
    /// crashing on an empty array.
    private func record(_ stage: LoopStage, startedAt: Date, duration: Double,
                        exitCode: Int32?, passed: Bool, output: String, score: Int?,
                        repairAttempted: Bool = false, changedPaths: [String] = [],
                        scopeVerdict: RepairScopeVerdict = .notChecked) {
        guard !iterationRecords.isEmpty else { return }
        iterationRecords[iterationRecords.count - 1].attempts.append(
            LoopStageAttempt(
                stageId: stage.id, stageName: stage.name, kind: stage.kind,
                severity: stage.severity, startedAt: startedAt, durationSeconds: duration,
                exitCode: exitCode, passed: passed, outputTail: output,
                outputHash: passed ? nil : Self.hash(output), score: score,
                repairAttempted: repairAttempted, changedPaths: changedPaths,
                scopeVerdict: scopeVerdict))
    }

    /// Sets the terminal status, logs it, writes the journal entry, and returns
    /// the status. Every exit from `run` goes through here so no path can end a
    /// run without journalling it.
    private func finish(_ terminal: LoopEngineStatus, config: LoopEngineConfig,
                        faultsRoot: URL, gitRoot: URL, projectId: String?,
                        startedAt: Date) async -> LoopEngineStatus {
        status = terminal
        appendLog(logLevel(for: terminal), "Loop finished · \(terminal.summary)")

        let record = LoopRunRecord(
            id: UUID().uuidString, projectId: projectId, trigger: trigger,
            gitRoot: gitRoot.path, startedAt: startedAt, endedAt: Date(),
            iterationsUsed: iteration, config: LoopRunConfigSnapshot(config),
            iterations: iterationRecords, statusCode: terminal.code,
            statusSummary: terminal.summary)
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

    // MARK: - Helpers

    /// One-line, human-readable regression-sweep result for the run log:
    /// either "passed — M of T" or "failed — R regressed / M passed of T".
    /// M = faults that still hold (.unchanged + .repaired).
    private static func regressionLine(_ outcome: SweepOutcome) -> String {
        let passedCount = outcome.unchanged + outcome.repaired
        if outcome.passed {
            return "passed — \(passedCount) of \(outcome.total)"
        }
        return "failed — \(outcome.regressed) regressed / \(passedCount) passed of \(outcome.total)"
    }

    /// Default agent message for a `.skill` stage with no user-written prompt:
    /// names the stage and, if set, the target source the skill is scoped to.
    /// The custom prompt when set, else a built-in default — either way with
    /// the input/output paths appended, so a user's own prompt text doesn't
    /// silently drop what they picked in the Input/Output fields. Both are
    /// text hints for the skill's own tool calls, not a mechanical redirect —
    /// the runner never reads or writes either path itself.
    private static func composeSkillMessage(_ stage: LoopStage) -> String {
        var msg = (stage.prompt?.isEmpty == false)
            ? stage.prompt!
            : "Apply the skill for stage \"\(stage.name)\"."
        if let target = stage.targetPath, !target.isEmpty {
            msg += " Input: \(Self.describePath(target))."
        }
        if let output = stage.outputPath, !output.isEmpty {
            msg += " Write output to: \(Self.describePath(output))."
        }
        return msg
    }

    /// `PathUtils.relative` returns "." for the project root itself — read
    /// naturally in a sentence ("Input: .." reads as a typo/ambiguous
    /// double-dot, not "the project root").
    private static func describePath(_ path: String) -> String {
        path == "." ? "the project root" : path
    }

    private func appendLog(_ level: LogLine.Level, _ text: String) {
        let line = LogLine(at: Date(), level: level, text: text)
        log.append(line)
        onLog?(line)
    }

    /// Returns the stage's command when non-nil and non-blank; nil
    /// otherwise. A missing/empty command is a config error, distinct
    /// from a stage that ran and failed.
    private static func validCommand(_ stage: LoopStage) -> String? {
        guard let command = stage.command,
              !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return command
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
    private static func hash(_ s: String) -> String {
        var normalized = s.replacingOccurrences(
            of: #"\d+\.\d+"#, with: "#", options: .regularExpression)
        normalized = normalized.replacingOccurrences(
            of: #"\b\d+\s*(ms|µs|ns|s|sec|seconds?)\b"#, with: "#", options: .regularExpression)
        normalized = normalized.replacingOccurrences(
            of: #"0x[0-9a-fA-F]+"#, with: "#", options: .regularExpression)
        let digest = SHA256.hash(data: Data(normalized.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func logLevel(for status: LoopEngineStatus) -> LogLine.Level {
        if case .success = status { return .info }
        return .error
    }
}

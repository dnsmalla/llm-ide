import Foundation
import SwiftUI
import AppKit
import Combine
import os.log

@MainActor
final class AutoCodeUpdateService: ObservableObject {

    // MARK: - Published state (for Settings UI)

    @Published var isEnabled: Bool
    // The class body is split across AutoCodeUpdateService+PipelineTasks.swift,
    // +CLI.swift, and +BackendResolution.swift (extensions of this same type,
    // different files) — Swift's `private` is file-scoped, so state those
    // extensions need to mutate can only be `internal` (the default, no
    // access keyword), not `private(set)`. This mirrors the exact tradeoff
    // CodeAssistantPanel.swift already made for its own +Session.swift/
    // +Agent.swift split (its @State properties dropped `private` too) —
    // "only this file can mutate" narrows to "only this module can mutate",
    // which is still a real boundary (nothing outside LlmIdeMacLib sees this
    // type at all), just not a per-file one.
    @Published var isRunning = false
    @Published var lastRunDate: Date?
    @Published var statusMessage = "Never run"
    @Published var createdCount = 0
    @Published var implementedCount = 0
    @Published var failedCount = 0
    @Published var allEntries: [ProcessedActionsRegistry.RegistryEntry] = []
    /// Recent Auto Task executions (newest first).
    @Published var runHistoryEntries: [AutoTaskRunRecord] = []
    @Published var lastError: String? = nil
    /// Human-readable reason for the last `resolveBackendAndProject()` nil —
    /// token / active-project / clone-path state. Surfaced in the task log +
    /// left-pane banner so a misconfigured backend is obvious, not a silent
    /// "no linked repo".
    @Published var lastResolveDiagnosis: String? = nil
    @Published var taskErrors: [String: String] = [:]
    /// Which task is running right now (drives the per-task ▶ spinner). nil when idle.
    @Published var currentTask: AutoTask? = nil
    /// Parallel to `currentTask` for the open, user-created task set —
    /// `AutoTask` is a closed enum and can't represent a custom task's id.
    /// At most one of `currentTask`/`currentCustomTaskId` is non-nil at a time.
    @Published var currentCustomTaskId: String? = nil
    /// Human-readable description of the currently running step (e.g., "Creating issues", "Running Review Code").
    /// nil when no run is active. Updated throughout the run() flow so the UI shows live progress.
    @Published var currentStep: String?

    // MARK: - Dependencies
    // (also internal rather than private, for the same cross-file reason as above)

    let config: AppConfig
    /// Internal-visible for tests (`dueTasks`/`realignNextFire` are unit-tested
    /// in isolation). The Settings UI already reads this; only `private` was
    /// dropped — no other change.
    let autoTaskSettings: AutoTaskSettings
    /// Optional override for tests / dependency injection. When nil (the
    /// normal app wiring) the service resolves a fresh RepoBackend each
    /// run via `resolveBackendAndProject()` so live token / active-repo
    /// changes from Settings are picked up without a restart.
    let backendOverride: RepoBackend?
    let registry: ProcessedActionsRegistry
    let runHistory: AutoTaskRunHistory
    let projectStore: ProjectStore?
    /// Optional API client used by the regression auto-task. When nil
    /// (e.g. older callers + tests), the regression step is skipped and the
    /// reason is surfaced via `taskErrors` ("Regression skipped — no API
    /// client wired."); the rest of the run is unaffected.
    let api: LlmIdeAPIClient?
    /// Per-task live log store; appended to from the CLI `Pipe` streamer and
    /// read by the Auto Task page. Defaults to a fresh store so existing
    /// callers/tests that omit it still compile; the app injects the shared
    /// instance the UI observes.
    let logStore: TaskLogStore
    /// Per-task input/output/skill/template selections, keyed by task id. Owned
    /// here (not injected) because the runner is the one thing every surface —
    /// the page, the scheduler, the mobile bridge — already has a handle on.
    let taskConfigs: AutoTaskConfigStore
    let log = Logger(subsystem: "com.llmide.macapp", category: "AutoCodeUpdateService")

    /// The project's saved Auto Task prompt templates. `weak` for the same
    /// reason as `activity`: the store is owned by the app's `@StateObject`.
    /// nil (no project open, older callers, tests) means every task falls back
    /// to its own prompt.
    weak var autoTaskTemplates: AutoTaskTemplateStore?

    /// Activity feed store. Set once by the app entry after construction.
    /// `weak` because the store is owned by the app's `@State`. Mirrors the
    /// `weak var config` pattern on `RegressionRunner`.
    weak var activity: ActivityStore?

    /// Notes folder + indexer for the Source Update pipeline task. Wired from
    /// `AppShell` when `AppEnvironment` is created for the active project.
    weak var environment: AppEnvironment?

    let repoManager = RepoManager()

    private var timer: Timer?
    private var cancellable: AnyCancellable?
    /// The in-flight run, so it can be cancelled (Stop button / timer
    /// shutdown). nil when no run is active. Only touched from the
    /// lifecycle section (runNow/runSingle/runDue/cancel), all of which
    /// stay in this file — kept `private`.
    private var runTask: Task<Void, Never>?
    /// The currently-executing CLI subprocess, so `cancel()` can kill it
    /// instead of waiting out its 10-minute timeout. Set/cleared on the
    /// main actor around each subprocess. Touched from `cancel()` here
    /// AND from runCLI in +CLI.swift — internal, not private.
    var activeProcess: Process?

    /// Which automated steps are permitted for a provider. Pure + static so the
    /// gating decision is unit-testable without running the full pipeline.
    static func allowedAutoSteps(config: AppConfig, provider: RepoBackendKind)
        -> (createIssue: Bool, createBranch: Bool, autoCommit: Bool) {
        (
            createIssue:  config.isAllowed(.createIssue,  provider: provider),
            createBranch: config.isAllowed(.createBranch, provider: provider),
            autoCommit:   config.isAllowed(.autoCommit,   provider: provider)
        )
    }

    // MARK: - Init

    @MainActor
    init(config: AppConfig, autoTaskSettings: AutoTaskSettings, backend: RepoBackend? = nil,
         registry: ProcessedActionsRegistry, runHistory: AutoTaskRunHistory? = nil,
         projectStore: ProjectStore? = nil,
         api: LlmIdeAPIClient? = nil, logStore: TaskLogStore) {
        self.config = config
        self.autoTaskSettings = autoTaskSettings
        self.backendOverride = backend
        self.registry = registry
        // The app always injects the real store (see `LlmIdeMacApp`). The nil
        // default exists only so older callers + tests keep compiling, so it
        // MUST NOT resolve to the production file: tests drive real runs, and
        // pointing them at Application Support would append test records to —
        // and, before a load, truncate — the user's actual history.
        self.runHistory = runHistory ?? AutoTaskRunHistory(
            storeURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("llmide-auto-task-runs-\(UUID().uuidString).json"))
        self.projectStore = projectStore
        self.api = api
        self.logStore = logStore
        // Same defaults suite the rest of the service uses, so a test that
        // injects an isolated suite gets isolated task settings too.
        self.taskConfigs = AutoTaskConfigStore(defaults: config.userDefaults)
        isEnabled = autoTaskSettings.enabled
        
        // Arm/disarm the scheduler from the single source of truth. Every
        // enable path (Menu, Settings, the Auto Tasks page, app boot) flows
        // through `autoTaskSettings.enabled`, so this is the ONE place that
        // toggles the actual timer — no surface needs to call start()/stop()
        // itself. dropFirst skips the initial value so we don't arm during
        // init (app boot arms via start() if already enabled).
        cancellable = autoTaskSettings.$enabled
            .dropFirst()
            .sink { [weak self] value in
                guard let self else { return }
                self.isEnabled = value
                if value { self.start() } else { self.stop() }
            }
    }

    // MARK: - Lifecycle

    func start() {
        guard timer == nil else { return }
        // Lazy registry bootstrap — disk read deferred from app launch
        // until first .task tick (when start() is called).
        registry.bootstrap()
        loadRunHistoryForDisplay()
        if let loadErr = registry.loadError {
            setError("Action history failed to load: \(loadErr.localizedDescription)")
        }
        if let saveErr = registry.initSaveError {
            setError("Action history failed to save on startup: \(saveErr.localizedDescription)")
        }
        scheduleTimer()
    }

    /// Arm the 60s cron-evaluation tick. Each tick runs every task whose
    /// `nextFireAt` is due, then realigns its next fire to the future.
    /// The cadence is per-task cron (`AutoTaskSettings.cron`), NOT a shared
    /// interval — this timer just wakes the scheduler once a minute to check.
    private func scheduleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.runDue(now: Date()) }
        }
    }

    /// Start a run through a stored, cancellable Task. Used by the timer and
    /// the Run Now button so an in-flight run can be stopped via `cancel()`.
    /// Returns false when a run is already scheduled or in flight.
    @discardableResult
    func runNow(trigger: AutoTaskRunTrigger = .pipeline) -> Bool {
        guard runTask == nil else { return false }
        runTask = Task { [weak self] in
            await self?.run(trigger: trigger)
            self?.runTask = nil
        }
        return true
    }

    /// Per-task manual run (the ▶ button on a task's page). Runs JUST that one
    /// task body, ignoring its enable checkbox. Shares the `runTask` re-entrancy
    /// guard with `runNow()` so a global run and a per-task run can't overlap.
    @discardableResult
    func runSingle(_ task: AutoTask, trigger: AutoTaskRunTrigger = .manual) -> Bool {
        guard runTask == nil else { return false }
        runTask = Task { [weak self] in
            await self?.runOne(task, trigger: trigger)
            self?.runTask = nil
        }
        return true
    }

    /// Phone-triggered "Run this stage only" (`loop_start_stage`). A dedicated
    /// entry point rather than a parameter on `runSingle(_:)`: no other task
    /// has a use for a stage id, and this keeps the generic signatures
    /// untouched. Shares the `runTask` re-entrancy guard, so it can never
    /// overlap a global run, a per-task run, or a custom run.
    @discardableResult
    func runSingleLoopStage(stageId: String, trigger: AutoTaskRunTrigger = .manual) -> Bool {
        guard runTask == nil else { return false }
        runTask = Task { [weak self] in
            await self?.runLoopFiltered(loopId: nil, stageId: stageId, trigger: trigger)
            self?.runTask = nil
        }
        return true
    }

    /// Phone-triggered "Start" on the Loop page (`loop_start`): run ONE loop —
    /// the one the phone is showing.
    ///
    /// The scheduled task runs every loop the project schedules, which is right
    /// for the scheduler and wrong here: the phone displays a single loop's
    /// stages, log and history, so starting three would report on one and run
    /// three. Same re-entrancy guard as every other entry point.
    @discardableResult
    func runSingleLoop(loopId: String, trigger: AutoTaskRunTrigger = .manual) -> Bool {
        guard runTask == nil else { return false }
        runTask = Task { [weak self] in
            await self?.runLoopFiltered(loopId: loopId, stageId: nil, trigger: trigger)
            self?.runTask = nil
        }
        return true
    }

    /// Body for both filtered loop entry points — the `.loopEngineering` slice
    /// of `runOne(_:)` with a loop and/or stage filter threaded through. Kept
    /// separate for the same reason `runCustomTask(_:)` is: the resolve/guard
    /// shell is per-entry-point state management, not shareable logic.
    private func runLoopFiltered(loopId: String?, stageId: String?,
                                 trigger: AutoTaskRunTrigger) async {
        guard !isRunning else { return }
        isRunning = true
        let startedAt = Date()
        let loopLabel = AutoTask.loopEngineering.label
        // Set once the sweep reports back; read by the defer below.
        var didStart = true
        defer {
            isRunning = false
            currentTask = nil
            currentStep = nil
            lastRunDate = Date()
            appendRunRecord(taskId: AutoTask.loopEngineering.rawValue, label: loopLabel,
                            logSuffix: AutoTask.loopEngineering.logSuffix, startedAt: startedAt,
                            trigger: trigger,
                            status: runStatus(forTaskId: AutoTask.loopEngineering.rawValue,
                                              didStart: didStart),
                            summary: statusMessage)
        }
        guard let resolved = resolveBackendAndProject() else {
            let reason = lastResolveDiagnosis ?? "No linked repo — configure in GitLab or GitHub settings"
            statusMessage = "No linked repo"
            logStore.append(.loopEngineering, "⚠ \(reason)", level: .error)
            taskErrors[AutoTask.loopEngineering.rawValue] = reason
            return
        }
        currentTask = .loopEngineering
        currentStep = stageId != nil ? "Running Loop stage" : "Running Loop"
        logStore.append(.loopEngineering,
                        stageId != nil ? "Running Loop (single stage)…" : "Running Loop (one loop)…")
        didStart = await runLoopEngineeringSweep(projectRoot: resolved.projectRoot,
                                                gitRoot: resolved.gitRoot,
                                                projectId: projectStore?.activeProject?.bundle.id,
                                                onlyStageId: stageId, onlyLoopId: loopId)
        statusMessage = "\(AutoTask.loopEngineering.label) — done"
    }

    /// The prompt a task actually runs: its selected `AutoTaskTemplate` when it
    /// has one, otherwise its own prompt (the built-in `AppConfig` template, or
    /// a custom task's inline text), with the task's input/output paths and
    /// skill folded in by `AutoTaskPromptComposer`.
    ///
    /// A task with no saved settings and no template composes to exactly its
    /// own prompt, unchanged — which is what every task did before templates
    /// existed, so the feature is inert until someone configures it.
    ///
    /// A `templateId` pointing at a template that is gone (deleted on disk,
    /// project closed) falls back to the own prompt rather than running an
    /// empty one: an unreadable template must not turn a scheduled task into a
    /// no-op the user only discovers in the log.
    ///
    /// `writesFiles` must match the `persistChanges:` the caller passes to
    /// `runCLI` — it is what stops a review task being told to write files its
    /// own post-run revert will delete.
    func composedPrompt(taskId: String, ownPrompt: String, projectRoot: String?,
                        writesFiles: Bool) -> String {
        let taskConfig = taskConfigs.config(for: taskId)
        let body = autoTaskTemplates?.template(id: taskConfig.templateId)?.body ?? ownPrompt
        let root = projectRoot.map { URL(fileURLWithPath: $0) }
        return AutoTaskPromptComposer.compose(body: body, config: taskConfig,
                                              projectRoot: root, writesFiles: writesFiles)
    }

    /// Custom-task counterpart to `runSingle(_:)` — shares the same
    /// `runTask` re-entrancy guard, so a built-in run and a custom run
    /// can't overlap either.
    @discardableResult
    func runSingleCustom(_ task: CustomAutoTask, trigger: AutoTaskRunTrigger = .manual) -> Bool {
        guard runTask == nil else { return false }
        runTask = Task { [weak self] in
            await self?.runCustomTask(task, trigger: trigger)
            self?.runTask = nil
        }
        return true
    }

    /// Custom-task counterpart to `runOne(_:)` — the same resolve/guard/
    /// runCLI pipeline the 5 built-in prompt tasks use (reviewCode etc. in
    /// `runTaskBody`), generalized to take an arbitrary `CustomAutoTask`
    /// instead of switching on a fixed `AutoTask` case. Every custom task
    /// requires a linked repo (there is no source-ingest-only custom task,
    /// unlike the built-in `sourceUpdate`).
    func runCustomTask(_ task: CustomAutoTask, trigger: AutoTaskRunTrigger = .manual) async {
        guard !isRunning else { return }
        isRunning = true
        currentCustomTaskId = task.id
        let startedAt = Date()
        defer {
            isRunning = false
            currentCustomTaskId = nil
            currentStep = nil
            lastRunDate = Date()
            appendRunRecord(taskId: task.id, label: task.name, logSuffix: task.id,
                            startedAt: startedAt, trigger: trigger,
                            status: runStatus(forTaskId: task.id),
                            summary: statusMessage)
        }
        guard let logDir = logsDirectory() else {
            statusMessage = "Logs directory unavailable"
            return
        }
        guard let resolved = resolveBackendAndProject() else {
            let reason = lastResolveDiagnosis ?? "No linked repo — configure in GitLab or GitHub settings"
            statusMessage = "No linked repo"
            logStore.append(task.id, "⚠ \(reason)", level: .error)
            taskErrors[task.id] = reason
            return
        }
        currentStep = "Running \(task.name)"
        logStore.append(task.id, "Running \(task.name)…")
        // `.implement` keeps its edits on an isolated branch; `.review` has them
        // reverted afterwards, so the two must describe the output path
        // differently — one value drives both the prompt and the enforcement.
        let persistChanges = task.mode == .implement
        let ok = await runCLI(prompt: composedPrompt(taskId: task.id, ownPrompt: task.template,
                                                     projectRoot: resolved.projectRoot,
                                                     writesFiles: persistChanges),
                              localPath: resolved.gitRoot,
                              logSuffix: task.id, logDir: logDir, logStoreId: task.id,
                              persistChanges: persistChanges)
        if ok {
            taskErrors.removeValue(forKey: task.id)
            logStore.append(task.id, "— run finished —")
        } else {
            taskErrors[task.id] = "\(task.name) task failed. Check ~/Library/Logs/\(AppIdentity.logsDirName)/auto-task-\(task.id).log"
            logStore.append(task.id, "— run failed —", level: .error)
        }
        statusMessage = "\(task.name) — done"
    }

    // MARK: - Cron-driven scheduling

    /// Tasks whose next fire is at or before `now` (and are enabled). Pure read —
    /// does not mutate state or run anything. `now` is injected for tests.
    func dueTasks(now: Date = Date()) -> [AutoTask] {
        guard autoTaskSettings.enabled else { return [] }
        return AutoTask.allCases.filter { task in
            // `isScheduleActive` is belt-and-braces next to `nextFireAt` — a
            // disarmed task has no fire to be due at. It is checked anyway so
            // a stale fire written by an older build (which had no active
            // flag) can never produce one last unwanted run before
            // `realignNextFire` clears it.
            guard autoTaskSettings.isEnabled(task: task),
                  autoTaskSettings.isScheduleActive(for: task),
                  let next = autoTaskSettings.nextFireAt(for: task) else { return false }
            return now >= next
        }
    }

    /// Advance a task's nextFireAt to the first fire strictly after `now`
    /// (catch up once → realign to the future). Testable seam.
    func realignNextFire(for task: AutoTask, now: Date) {
        guard autoTaskSettings.isScheduleActive(for: task),
              let expr = CronExpression.parse(autoTaskSettings.cron(for: task)),
              let next = expr.nextFire(after: now, now: now) else {
            autoTaskSettings.setNextFireAt(nil, for: task); return
        }
        autoTaskSettings.setNextFireAt(next, for: task)
    }

    /// Enabled custom tasks (cron != nil) whose `customNextFireAt` is at or
    /// before `now`. The custom-task parallel of `dueTasks(now:)` — pure read,
    /// does not mutate state or run anything. `now` is injected for tests.
    /// Loads from the same `UserDefaults` this service's `config` was
    /// constructed with, so tests stay isolated via their injected suite.
    func dueCustomTasks(now: Date = Date()) -> [CustomAutoTask] {
        guard autoTaskSettings.enabled else { return [] }
        return CustomAutoTask.loadAll(from: config.userDefaults).filter { task in
            guard task.isEnabled, task.cron != nil,
                  let next = autoTaskSettings.customNextFireAt(for: task.id) else { return false }
            return now >= next
        }
    }

    /// Advance a custom task's customNextFireAt to the first fire strictly
    /// after `now`. Mirrors `realignNextFire(for:now:)` but uses the task's own
    /// `cron` (custom tasks carry their schedule on the model, not in
    /// `AutoTaskSettings`). Clears the fire when cron is nil/invalid so a
    /// manual task can't be left stuck "due".
    func realignCustomNextFire(for task: CustomAutoTask, now: Date) {
        guard let cron = task.cron,
              let expr = CronExpression.parse(cron),
              let next = expr.nextFire(after: now, now: now) else {
            autoTaskSettings.setCustomNextFireAt(nil, for: task.id); return
        }
        autoTaskSettings.setCustomNextFireAt(next, for: task.id)
    }

    /// Run every task due at `now` — built-in AND custom — once, then realign
    /// each. Shares the `runTask` re-entrancy guard with
    /// `runNow()`/`runSingle(_:)`. Each due task's nextFireAt is realigned
    /// BEFORE its body runs so a slow run can't cause a double-fire on the next
    /// tick (applies to both kinds). Returns false when nothing is due or a run
    /// is already in flight.
    @discardableResult
    func runDue(now: Date = Date()) -> Bool {
        let dueBuiltIn = dueTasks(now: now)
        let dueCustom = dueCustomTasks(now: now)
        guard !(dueBuiltIn.isEmpty && dueCustom.isEmpty), runTask == nil else { return false }
        for task in dueBuiltIn { realignNextFire(for: task, now: now) }       // realign BEFORE running
        for task in dueCustom { realignCustomNextFire(for: task, now: now) }
        runTask = Task { [weak self] in
            for task in dueBuiltIn { await self?.runOne(task, trigger: .cron) }
            for task in dueCustom { await self?.runCustomTask(task, trigger: .cron) }
            self?.runTask = nil
        }
        return true
    }

    /// True while a run Task is queued or executing (including the gap before
    /// `isRunning` flips true). Used by mobile control to reject duplicate runs.
    var hasScheduledRun: Bool { runTask != nil }

    /// Resolve backend/project once, then run a single task body.
    private func runOne(_ task: AutoTask, trigger: AutoTaskRunTrigger) async {
        guard !isRunning else { return }
        isRunning = true
        let startedAt = Date()
        defer {
            isRunning = false
            currentTask = nil
            currentStep = nil
            lastRunDate = Date()
        }
        guard let logDir = logsDirectory() else {
            statusMessage = "Logs directory unavailable"
            appendRunRecord(taskId: task.rawValue, label: task.label,
                            logSuffix: task.logSuffix, startedAt: startedAt,
                            trigger: trigger, status: .failed,
                            summary: "Logs directory unavailable")
            return
        }
        if task.requiresLinkedRepo {
            guard let resolved = resolveBackendAndProject() else {
                let reason = lastResolveDiagnosis ?? "No linked repo — configure in GitLab or GitHub settings"
                statusMessage = "No linked repo"
                logStore.append(task, "⚠ \(reason)", level: .error)
                taskErrors[task.rawValue] = reason
                appendRunRecord(taskId: task.rawValue, label: task.label,
                                logSuffix: task.logSuffix, startedAt: startedAt,
                                trigger: trigger, status: .failed, summary: reason)
                return
            }
            await runTaskBody(task, resolved: resolved, projectId: projectStore?.activeProject?.bundle.id,
                              logDir: logDir, startedAt: startedAt, trigger: trigger)
        } else {
            await runTaskBody(task, resolved: nil, projectId: projectStore?.activeProject?.bundle.id,
                              logDir: logDir, startedAt: startedAt, trigger: trigger)
        }
        statusMessage = "\(task.label) — done"
    }

    /// Run a single task body. Called by the orchestrator `run()` (enabled
    /// tasks) and by `runOne(_:)` (per-task manual run). Each case logs a start
    /// marker and routes its output into `logStore[task]`.
    ///
    /// - Parameter projectId: The active llm-ide `Project.id`, resolved by
    ///   the CALLER at the same time as `resolved` — see `.loopEngineering`'s
    ///   use below and the doc comment on `runLoopEngineeringSweep`. Not
    ///   re-derived here so a project switch mid-batch (`run()`'s
    ///   `enabledOrder` loop runs several tasks in sequence with awaits
    ///   between them) can't pair a later task with a DIFFERENT project's id
    ///   than the one `resolved` was computed against.
    private func runTaskBody(_ task: AutoTask, resolved: ResolvedRepo?, projectId: String?, logDir: URL,
                             startedAt: Date, trigger: AutoTaskRunTrigger) async {
        // Only the Loop sweep can report "nothing started"; every other task
        // body runs to a terminal status by construction.
        var didStart = true
        defer {
            appendRunRecord(taskId: task.rawValue, label: task.label,
                            logSuffix: task.logSuffix, startedAt: startedAt,
                            trigger: trigger,
                            status: runStatus(forTaskId: task.rawValue, didStart: didStart),
                            summary: taskErrors[task.rawValue])
        }
        logStore.append(task, "Running \(task.label)…")
        currentTask = task
        defer { currentTask = nil }
        switch task {
        case .sourceUpdate:
            currentStep = "Updating sources"
            await runSourceUpdate()
        default:
            guard let resolved else {
                logStore.append(task, "⚠ No linked repo", level: .error)
                taskErrors[task.rawValue] = lastResolveDiagnosis ?? "No linked repo"
                return
            }
            switch task {
            case .sourcesToIssue:
                currentStep = "Creating issues from notes"
                await runSourcesToIssue(resolved: resolved)
            case .implementIssues:
                currentStep = "Implementing pending issues"
                await runImplementIssues(resolved: resolved, logDir: logDir)
            case .reviewMerge:
                currentStep = "Pushing branches and opening MRs"
                await runReviewMerge(resolved: resolved)
            case .reviewCode:
                currentStep = "Running Review Code"
                let ok = await runCLI(prompt: composedPrompt(taskId: task.rawValue,
                                                             ownPrompt: config.autoTaskTemplateReviewCode,
                                                             projectRoot: resolved.projectRoot,
                                                             writesFiles: false),
                                      localPath: resolved.gitRoot, logSuffix: task.logSuffix,
                                      logDir: logDir, logStoreId: task.rawValue)
                finishPromptTask(task, ok: ok)
            case .reviewDoc:
                currentStep = "Running Review Doc"
                let ok = await runCLI(prompt: composedPrompt(taskId: task.rawValue,
                                                             ownPrompt: config.autoTaskTemplateReviewDoc,
                                                             projectRoot: resolved.projectRoot,
                                                             writesFiles: false),
                                      localPath: resolved.gitRoot, logSuffix: task.logSuffix,
                                      logDir: logDir, logStoreId: task.rawValue)
                finishPromptTask(task, ok: ok)
            case .reviewConflicts:
                currentStep = "Running Review Conflicts"
                let ok = await runCLI(prompt: composedPrompt(taskId: task.rawValue,
                                                             ownPrompt: config.autoTaskTemplateReviewConflicts,
                                                             projectRoot: resolved.projectRoot,
                                                             writesFiles: false),
                                      localPath: resolved.gitRoot, logSuffix: task.logSuffix,
                                      logDir: logDir, logStoreId: task.rawValue)
                finishPromptTask(task, ok: ok)
            case .generateDoc:
                currentStep = "Generating Documentation"
                let ok = await runCLI(prompt: composedPrompt(taskId: task.rawValue,
                                                             ownPrompt: config.autoTaskTemplateGenerateDoc,
                                                             projectRoot: resolved.projectRoot,
                                                             writesFiles: false),
                                      localPath: resolved.gitRoot, logSuffix: task.logSuffix,
                                      logDir: logDir, logStoreId: task.rawValue)
                finishPromptTask(task, ok: ok)
            case .updateIssues:
                currentStep = "Updating Issues"
                let ok = await runCLI(prompt: composedPrompt(taskId: task.rawValue,
                                                             ownPrompt: config.autoTaskTemplateUpdateIssues,
                                                             projectRoot: resolved.projectRoot,
                                                             writesFiles: false),
                                      localPath: resolved.gitRoot, logSuffix: task.logSuffix,
                                      logDir: logDir, logStoreId: task.rawValue)
                finishPromptTask(task, ok: ok)
            case .regression:
                currentStep = "Running Regression sweep"
                await runRegressionSweep(projectRoot: resolved.projectRoot, gitRoot: resolved.gitRoot)
            case .loopEngineering:
                currentStep = "Running Loop"
                didStart = await runLoopEngineeringSweep(
                    projectRoot: resolved.projectRoot, gitRoot: resolved.gitRoot, projectId: projectId)
            case .generateKnowledge:
                currentStep = "Reviewing Knowledge"
                reportKnowledge(projectRoot: resolved.projectRoot)
            case .updatePlanStatus:
                currentStep = "Refreshing Plan statuses"
                await refreshPlanStatuses(projectRoot: resolved.projectRoot)
            default:
                break
            }
        }
    }

    /// Shared success/error bookkeeping for the 5 prompt tasks.
    private func finishPromptTask(_ task: AutoTask, ok: Bool) {
        if ok {
            taskErrors.removeValue(forKey: task.rawValue)
            logStore.append(task, "— run finished —")
        } else {
            taskErrors[task.rawValue] = "\(task.label) task failed. Check ~/Library/Logs/\(AppIdentity.logsDirName)/auto-task-\(task.logSuffix).log"
            logStore.append(task, "— run failed —", level: .error)
        }
    }

    /// Stop the in-flight run: cancel the run Task (so it bails at the next
    /// task boundary) and terminate the currently-executing subprocess (so
    /// we don't wait out its 10-minute timeout).
    func cancel() {
        runTask?.cancel()
        activeProcess?.terminate()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        // Disabling auto-tasks also stops any run that's currently executing.
        cancel()
    }

    func setError(_ message: String) {
        lastError = message
    }

    func dismissLastError() {
        lastError = nil
    }

    func dismissTaskError(for task: AutoTask) {
        taskErrors.removeValue(forKey: task.rawValue)
    }

    func dismissTaskError(forId id: String) {
        taskErrors.removeValue(forKey: id)
    }

    deinit {
        timer?.invalidate()
    }

    // MARK: - Main run loop

    func run(trigger: AutoTaskRunTrigger = .pipeline) async {
        guard !isRunning else { return }
        isRunning = true
        currentStep = "Initializing"
        createdCount = 0
        implementedCount = 0
        failedCount = 0
        lastError = nil
        taskErrors = [:]
        // Auto-stash bookkeeping (opt-in). Declared before the defer so the
        // defer can always restore, even on an early return.
        var didStash = false
        var stashBranch: String? = nil
        var stashPath: String? = nil
        defer {
            isRunning = false
            currentStep = nil
            lastRunDate = Date()
            // Restore the stash OFF the main actor — checkout + pop can be slow
            // on a large repo and must not freeze the UI. Fire-and-forget; on a
            // failed restore the stash is retained and we surface a recovery
            // note. (defer can't await, hence the detached Task.)
            if didStash, let p = stashPath {
                let branch = stashBranch
                Task.detached(priority: .userInitiated) {
                    if !Self.restoreStash(at: p, originalBranch: branch) {
                        await MainActor.run { [weak self] in
                            self?.lastError = "Auto Tasks stashed your uncommitted changes but couldn't restore them cleanly — they're safe in `git stash` (the repo may be left on a fix/* branch). Run `git stash pop` to recover."
                        }
                    }
                }
            }
        }

        // .generateKnowledge only reports on the Graph/memory artifacts —
        // there's nothing to report in a build with Graph compiled out, so
        // it's dropped from the pipeline order (the row reads skipped rather
        // than a false green). `reportKnowledge` itself still guards on
        // `FeatureCatalog.isGraphCompiled` for the manual `runSingle` path,
        // which bypasses this list.
        let enabledOrder: [AutoTask] = [
            .sourceUpdate, .sourcesToIssue, .implementIssues, .reviewMerge,
            .reviewCode, .reviewDoc, .reviewConflicts,
            .updateIssues, .updatePlanStatus, .generateDoc,
            .regression, .generateKnowledge,
        ].filter { $0 != .generateKnowledge || FeatureCatalog.isGraphCompiled }

        let needsRepo = enabledOrder.contains { isTaskEnabled($0) && $0.requiresLinkedRepo }
        let resolved: ResolvedRepo? = needsRepo ? resolveBackendAndProject() : nil
        // Captured once here, alongside `resolved` — NOT re-read inside each
        // task body — so a project switch partway through this batch (every
        // task below runs in sequence with awaits in between) can't pair a
        // later task with a different project's id than `resolved` itself
        // was resolved against. See `runTaskBody`'s `projectId` parameter.
        let projectIdAtResolveTime = projectStore?.activeProject?.bundle.id

        if needsRepo && resolved == nil {
            let reason = lastResolveDiagnosis ?? "No linked repo — configure in GitLab or GitHub settings"
            setError(reason)
        }

        // Opt-in: stash uncommitted changes so the dirty-tree guard doesn't
        // skip implement/review tasks. Restored in the defer above.
        if autoTaskSettings.autoStash, let gitRoot = resolved?.gitRoot {
            let stashResult: (didStash: Bool, branch: String?) = await Task.detached {
                guard !Self.isWorkingTreeClean(at: gitRoot) else { return (false, nil) }
                let branch = Self.currentBranch(at: gitRoot)
                return (Self.stashPush(at: gitRoot), branch)
            }.value
            if stashResult.didStash {
                didStash = true
                stashBranch = stashResult.branch
                stashPath = gitRoot
            }
        }

        guard let logDir = logsDirectory() else {
            statusMessage = "Logs directory unavailable"
            return
        }

        for task in enabledOrder where isTaskEnabled(task) {
            if Task.isCancelled { break }
            await runTaskBody(task, resolved: resolved, projectId: projectIdAtResolveTime, logDir: logDir,
                              startedAt: Date(), trigger: trigger)
        }

        let parts: [String] = [
            createdCount > 0 ? "\(createdCount) created" : nil,
            implementedCount > 0 ? "\(implementedCount) implemented" : nil,
            failedCount > 0 ? "\(failedCount) failed" : nil,
        ].compactMap { $0 }

        if Task.isCancelled {
            statusMessage = parts.isEmpty ? "Cancelled" : "Cancelled · " + parts.joined(separator: " · ")
        } else if parts.isEmpty {
            statusMessage = resolved == nil && needsRepo ? "No linked repo" : "Done — nothing to do"
        } else {
            statusMessage = parts.joined(separator: " · ")
        }
        allEntries = registry.allEntries()
    }

    // MARK: - Helpers

    // MARK: - Backend resolution

    /// Resolved backend + project tuple returned by `resolveBackendAndProject`.
    /// Carries BOTH workspace roots (see `WorkspaceRoot.Context`):
    ///   • `gitRoot` — the git working tree: git ops (stash/commit) + agent cwd.
    ///   • `projectRoot` — owns `system/` data: faults / index / memory.
    /// In the clone-into-code model these differ (`code/<repo>` vs the project
    /// folder); in the project-is-a-repo (linkedRepo) model they're the same.
    struct ResolvedRepo {
        let client: RepoBackend
        let projectId: String
        let gitRoot: String
        let projectRoot: String
    }

    /// Pick the active repo target for an auto-task run. Order:
    ///   1. test `backendOverride` (if set);
    ///   2. the active project's `linkedRepo` (authoritative when set —
    ///      requires the matching token; no fall-through);
    ///   3. legacy: the active CLONED saved repo (GitLab first, then GitHub),
    ///      matching `AppConfig.activeRepoLocalURL`'s `isActive && isCloned`
    ///      predicate — a local clone path is enough; `resolvedId` is
    ///      best-effort (the clone flow doesn't populate it).
    /// Returns nil when none yield a usable local clone + token.
    func resolveBackendAndProject() -> ResolvedRepo? {
        if let resolved = attemptResolveBackendAndProject() { return resolved }
        let d = resolveDiagnosis()
        lastResolveDiagnosis = d
        log.warning("auto_task_resolve_failed \(d, privacy: .public)")
        return nil
    }

    /// Side-effect-free existence check for SwiftUI view bodies (e.g.
    /// AutoCodeView's "no linked repo" warning). NEVER call
    /// `resolveBackendAndProject()` from a view: it writes the
    /// `@Published lastResolveDiagnosis` on failure, and mutating
    /// observed state while SwiftUI is evaluating a body that reads it
    /// triggers an immediate re-invalidation of that same body — an
    /// infinite render loop (100% CPU, fully unresponsive app,
    /// including Quit). This runs the identical lookup with no writes.
    var hasResolvableBackend: Bool {
        attemptResolveBackendAndProject() != nil
    }

    /// Preserve the previous run's log instead of clobbering it: rename an
    /// existing log to `<name>.prev.<ext>` (overwriting any older `.prev`)
    /// before the caller truncates/creates a fresh one. Keeps exactly one
    /// prior run per task — bounded growth, but the last run is never lost.
    nonisolated static func rotateLog(at url: URL) {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return }
        let prev = url.deletingPathExtension()
            .appendingPathExtension("prev." + url.pathExtension)
        try? fm.removeItem(at: prev)
        try? fm.moveItem(at: url, to: prev)
    }

    /// Reveal the auto-task logs folder in Finder. Review tasks write their
    /// findings to log files; this is the one-click way to read them.
    func revealLogsInFinder() {
        guard let dir = logsDirectory() else { return }
        NSWorkspace.shared.activateFileViewerSelecting([dir])
    }

    func revealLogFile(named fileName: String) {
        guard let dir = logsDirectory() else { return }
        let url = dir.appendingPathComponent(fileName)
        guard FileManager.default.fileExists(atPath: url.path) else {
            revealLogsInFinder()
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    /// Publish the stored history without arming the scheduler. `start()` only
    /// runs when the Auto Task cron is enabled (default off), so the Auto Code
    /// page has to seed itself — otherwise it reports "no runs recorded yet"
    /// over a populated store. Also surfaces a load error the same way `start()`
    /// does, so a quarantined file isn't silent for cron-disabled users.
    func loadRunHistoryForDisplay() {
        runHistory.bootstrap()
        if let err = runHistory.loadError {
            setError("Run history failed to load: \(err.localizedDescription)")
        }
        refreshRunHistory()
    }

    private func refreshRunHistory() {
        runHistoryEntries = runHistory.recentEntries(limit: 50)
    }

    /// `didStart` is false only when a sweep bailed out before any work
    /// reached a terminal status — that is `.skipped`, not a silent `.success`.
    /// Cancellation still wins: a run the user stopped reads as `.cancelled`.
    private func runStatus(forTaskId taskId: String, didStart: Bool = true) -> AutoTaskRunStatus {
        if Task.isCancelled { return .cancelled }
        if !didStart { return .skipped }
        if taskErrors[taskId] != nil { return .failed }
        return .success
    }

    private func appendRunRecord(taskId: String, label: String, logSuffix: String?,
                                 startedAt: Date, trigger: AutoTaskRunTrigger,
                                 status: AutoTaskRunStatus, summary: String?) {
        runHistory.record(AutoTaskRunRecord(
            id: UUID().uuidString,
            taskId: taskId,
            taskLabel: label,
            trigger: trigger,
            startedAt: startedAt,
            finishedAt: Date(),
            status: status,
            summary: summary,
            logFileName: logSuffix.map { "auto-task-\($0).log" },
            projectId: projectStore?.activeProject?.bundle.id
        ))
        refreshRunHistory()
    }

    private func logsDirectory() -> URL? {
        let url = AppIdentity.logsRoot()
        return url
    }
}

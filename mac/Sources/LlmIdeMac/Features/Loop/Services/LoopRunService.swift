import Foundation

/// App-lifetime owner of desktop-initiated Loop runs.
///
/// `LoopEngineRunner` used to be a `@StateObject` on `LoopEngineView`, which
/// tied every run to the page that started it: navigating away orphaned the
/// only Stop handle, a project switch cleared the visible log of a run still
/// in flight, and no other surface could observe live progress. This service
/// owns one long-lived runner per (project, loop) instead — views borrow the
/// runner to render its `@Published` state and route start/stop through here,
/// so a run outlives any page and Stop works from wherever the run is shown.
///
/// The Auto Task scheduler keeps its own runner (`AutoCodeUpdateService`);
/// the two serialize through the process-wide `LoopRunQueue` as before.
@MainActor
final class LoopRunService: ObservableObject, SessionScoped {

    /// Keys (`projectId::loopId`) with a desktop run in flight or queued —
    /// published so the loop list's running indicator updates the moment a
    /// run starts or ends, instead of only on the next unrelated render.
    @Published private(set) var activeKeys: Set<String> = []

    /// One shared approval store for every runner and every page. All
    /// instances read the same UserDefaults key, so sharing one object is
    /// about not relying on that coincidence — the same reasoning
    /// `LoopEngineView` documented when it owned its own pair.
    let approvals = VerifyApprovalStore()

    /// Reporting sinks, wired at boot. Weak: the service must not keep the
    /// app-level stores alive, mirroring `AutoCodeUpdateService.activity`.
    weak var activity: ActivityStore?
    weak var logStore: (any TaskLogWriting)?

    /// A run on the Auto Task loop lane (started from the phone or the
    /// schedule), keyed like `activeKeys`. The Loop page shows it and routes
    /// its Stop to `cancelLoopLane` instead of pretending nothing is running.
    struct LaneRun {
        let runner: LoopEngineRunner
        let trigger: LoopRunTrigger
        /// Who started it, for the page's wording.
        var source: String { trigger == .phone ? "phone" : "schedule" }
        /// "Running (started from phone)" — the live header's label.
        var label: String { "Running (started from \(source))" }
    }
    @Published private(set) var laneRuns: [String: LaneRun] = [:]
    /// Stops the loop lane. Wired at boot by the Shell (the lane belongs to
    /// the Auto Task scheduler, which Loop must not name).
    var cancelLoopLane: (() -> Void)?

    /// Which run a Stop pressed on the Loop page addresses.
    enum StopTarget: Equatable { case desktop, lane, none }

    private let api: LlmIdeAPIClient
    private var runners: [String: LoopEngineRunner] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    /// Bumped by `resetForSignOut`. A run (or runner log sink) captures it when it starts and goes
    /// silent once it changes: `LoopEngineRunner` keeps `.success` when cancelled late, so a run
    /// finishing after sign-out would otherwise report under the next account's token.
    private(set) var sessionEpoch = 0

    init(api: LlmIdeAPIClient) {
        self.api = api
        // Loop may name Core; Core never names Loop, so the service enrolls
        // itself for sign-out resets.
        SessionScopedRegistry.shared.register(self)
    }

    /// Cancels every desktop and lane run and drops the previous account's
    /// idle runners (and their live logs). A runner whose run is still
    /// unwinding stays in `runners` so pause/resume and the page keep
    /// addressing it; its task drops it (and reports nothing) once it sees the
    /// new epoch. `laneRuns` is left alone: `onAdmissionChange(false)` clears
    /// it when the lane run ends, and Stop must keep resolving until then.
    func resetForSignOut() {
        sessionEpoch += 1
        for task in tasks.values { task.cancel() }
        cancelLoopLane?()
        for (key, runner) in runners {
            runner.onLog = nil
            if tasks[key] == nil { runners[key] = nil }
        }
    }

    static func key(projectId: String, loopId: String) -> String {
        "\(projectId)::\(loopId)"
    }

    /// The long-lived runner for this loop, created on first use. Keyed per
    /// (project, loop) so each loop keeps its own live log and stage states
    /// across page and project switches, and two projects can never share
    /// run state through a coincidentally equal loop id.
    func runner(projectId: String, loopId: String) -> LoopEngineRunner {
        let key = Self.key(projectId: projectId, loopId: loopId)
        if let existing = runners[key] { return existing }
        // Same dependency graph LoopEngineView.init used to build: the full
        // chat model tier for stage repair (a multi-file code edit), per
        // AgentLoopStageRepairer's own doc comment.
        // Tier routing, same as LoopRunnerProvider: resolved per replay call
        // (this runner is cached per loop), nil keeps the default.
        let prompter = CodeAssistPrompter(api: api, agent: "claude_code",
                                          routeResolver: LoopReplayTierRoute.resolve)
        let regressionRunner = RegressionRunner(
            prompter: prompter, judge: CodeAssistJudge(api: api),
            verifier: ShellFaultVerifier(),
            repairer: AgentFaultRepairer(api: api, routeResolver: LoopAgentTierRoute.resolve))
        let runner = LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api, routeResolver: LoopAgentTierRoute.resolve),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner),
            skillExecutor: AgentLoopSkillExecutor(api: api, routeResolver: LoopAgentTierRoute.resolve),
            approvals: approvals,
            repoRegistrar: APILoopRepoRegistrar(api: api),
            defaultShellTimeout: TimeInterval(LoopEngineDefaults.stageTimeouts().shellSeconds),
            defaultAgentTimeout: TimeInterval(LoopEngineDefaults.stageTimeouts().agentSeconds),
            checksCommandAvailability: true,
            changeShipper: LoopShipCoordinator(config: AppConfig.shared))
        // Mirror into the shared per-task log — the buffer the Auto Tasks
        // page and the phone read — so page-driven runs stay visible there.
        // Owned here (not per page appearance) so the mirror survives the
        // page being closed mid-run.
        let epoch = sessionEpoch
        runner.onLog = { [weak self] line in
            guard let self, self.sessionEpoch == epoch else { return }
            self.logStore?.append(AutoTask.loopEngineering.rawValue, line.text,
                                   level: line.level == .error ? .error : .info)
        }
        runners[key] = runner
        return runner
    }

    /// Whether THIS service has a run in flight or queued for the loop.
    /// Desktop runs only — scheduler/worktree runs are visible through
    /// `LoopEngineRunner.isLoopActive` as before.
    func isRunning(projectId: String, loopId: String) -> Bool {
        activeKeys.contains(Self.key(projectId: projectId, loopId: loopId))
    }

    /// Starts a run and owns its `Task`, so Stop works from any surface —
    /// not just the page that pressed Run, and not only while that page
    /// stays mounted. `onFinish` fires on the main actor with the terminal
    /// status (`nil` = the runner refused to start, e.g. already active).
    func start(projectId: String, loopId: String, loopName: String,
               config: LoopEngineConfig, faultsRoot: URL, gitRoot: URL,
               goal: String?, acceptanceCriteria: String?, scopeGlobs: [String],
               onFinish: @escaping @MainActor (LoopEngineStatus?) -> Void) {
        let key = Self.key(projectId: projectId, loopId: loopId)
        // The runner's own admission guard would refuse too, but refusing
        // here keeps `tasks[key]` (the one Stop handle) from being replaced
        // while the first run still owns it.
        guard tasks[key] == nil else {
            onFinish(nil)
            return
        }
        let runner = runner(projectId: projectId, loopId: loopId)
        // The runner outlives Settings edits; re-read the app defaults per run.
        let timeouts = LoopEngineDefaults.stageTimeouts()
        runner.defaultShellTimeout = TimeInterval(timeouts.shellSeconds)
        runner.defaultAgentTimeout = TimeInterval(timeouts.agentSeconds)
        activeKeys.insert(key)
        // The user just pressed Run, so they are looking at the app — the
        // one moment the one-shot permission alert can actually be seen.
        LoopRunNotifier.prepareAuthorization()
        let startedAt = Date()
        let epoch = sessionEpoch
        tasks[key] = Task { [weak self] in
            let result = await runner.run(
                config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                projectId: projectId, loopId: loopId, loopName: loopName,
                goal: goal, acceptanceCriteria: acceptanceCriteria,
                scopeGlobs: scopeGlobs)
            guard let self else { return }
            self.tasks[key] = nil
            self.activeKeys.remove(key)
            guard self.sessionEpoch == epoch else {
                // Signed out mid-run: nothing about it may reach the next account's feed,
                // notifications or page callbacks.
                if self.runners[key] === runner {
                    runner.onLog = nil
                    self.runners[key] = nil
                }
                return
            }
            if let result {
                self.reportFinished(loopName: loopName, status: result,
                                    iterations: runner.iteration,
                                    duration: Date().timeIntervalSince(startedAt),
                                    flakyStages: runner.flakyStages)
            }
            onFinish(result)
        }
    }

    /// Cancels the loop's in-flight (or queued) run, if any. Cooperative —
    /// the runner reports `.aborted` and still journals, same as the page's
    /// old `runTask?.cancel()`.
    func stop(projectId: String, loopId: String) {
        tasks[Self.key(projectId: projectId, loopId: loopId)]?.cancel()
    }

    /// Stops whatever desktop run is in flight for ANY loop of `projectId`.
    /// For callers that address a project rather than a loop — the phone,
    /// which only ever sees the Primary loop but whose Stop must not leave a
    /// desktop run for a different loop of the same project going.
    func stopAll(projectId: String) {
        let prefix = "\(projectId)::"
        for (key, task) in tasks where key.hasPrefix(prefix) {
            task.cancel()
        }
    }

    /// Registers a runner `LoopRunnerProvider` made for the loop lane, so its
    /// runs appear in `laneRuns` while admitted.
    func attachLaneRunner(_ runner: LoopEngineRunner, trigger: LoopRunTrigger) {
        runner.onAdmissionChange = { [weak self, weak runner] projectId, loopId, active in
            guard let self, let runner, let projectId else { return }
            let key = Self.key(projectId: projectId, loopId: loopId)
            if active {
                self.laneRuns[key] = LaneRun(runner: runner, trigger: trigger)
            } else if self.laneRuns[key]?.runner === runner {
                self.laneRuns[key] = nil
            }
        }
    }

    /// The lane run in flight (or queued) for this loop, if any.
    func laneRun(projectId: String, loopId: String) -> LaneRun? {
        laneRuns[Self.key(projectId: projectId, loopId: loopId)]
    }

    /// A desktop run is this page's own and wins; otherwise a lane run.
    static func stopTarget(desktopActive: Bool, laneActive: Bool) -> StopTarget {
        desktopActive ? .desktop : (laneActive ? .lane : .none)
    }

    /// Stop whichever run the Loop page is showing for this loop.
    func stopShownRun(projectId: String, loopId: String) {
        switch Self.stopTarget(desktopActive: tasks[Self.key(projectId: projectId, loopId: loopId)] != nil,
                               laneActive: laneRun(projectId: projectId, loopId: loopId) != nil) {
        case .desktop: stop(projectId: projectId, loopId: loopId)
        case .lane: cancelLoopLane?()
        case .none: break
        }
    }

    /// Hold the loop's run at its next stage boundary. Only meaningful for a
    /// run this service owns; the runner itself refuses unless it is
    /// executing (see `LoopEngineRunner.pause`).
    func pause(projectId: String, loopId: String) {
        runners[Self.key(projectId: projectId, loopId: loopId)]?.pause()
    }

    /// Release a hold placed by `pause`.
    func resume(projectId: String, loopId: String) {
        runners[Self.key(projectId: projectId, loopId: loopId)]?.resume()
    }

    /// One report per finished desktop run: the activity feed (previously
    /// only the Auto Task path reported there) and, when the app is in the
    /// background, a user notification.
    private func reportFinished(loopName: String, status: LoopEngineStatus,
                                iterations: Int, duration: TimeInterval, flakyStages: [String] = []) {
        // `.aborted` is the user's own Stop (or app quit) — announcing an
        // action back to the person who just took it is noise, in the feed
        // and doubly so as a "needs attention" banner.
        guard status.code != LoopEngineStatus.aborted.code else { return }
        activity?.report(
            kind: .loopEngineeringDone,
            title: "\(loopName): \(status.summary)",
            detail: ["status": status.code,
                     "iterations": iterations,
                     "durationSeconds": Int(duration)])
        LoopRunNotifier.notifyRunFinished(loopName: loopName, status: status,
                                          duration: duration, flakyStages: flakyStages)
    }
}

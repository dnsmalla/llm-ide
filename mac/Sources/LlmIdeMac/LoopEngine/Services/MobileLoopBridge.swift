import Foundation
import SharedProtocol

/// Serves the `loop_*` slice of the mobile protocol on behalf of
/// `MobileControlManager` — see `MobileFeatureBridge`'s doc comment for why
/// the manager holds this behind a protocol rather than this concrete type.
///
/// Every method below is the pre-split `MobileControlManager` body moved
/// verbatim (Phase 2c Task 1): `self`-implicit references to the manager's
/// `append`/`reply`/`decoder`/`config`/`projectStore` became
/// `manager?.`-qualified, and the manager's own `logStore` read became
/// `autoCode?.logStore` (this bridge holds no `logStore` of its own — the
/// auto-code service already owns one, and `loopEngineering` is itself an
/// Auto Task under the hood).
///
/// The phone is a CONTROL SURFACE only — no part of running a loop lives on
/// it or in this bridge. Starting one delegates to the Mac's existing
/// `loopEngineering` auto task, which is the single path that already wires
/// every dependency a run needs (stage repairer, regression sweep, skill
/// executor, journal) and produces a journal record identical to a scheduled
/// run's. Reimplementing that here would have been a second runner
/// construction to keep in step with the first.
@MainActor
final class MobileLoopBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?
    var autoCode: AutoCodeUpdateService?

    /// True while a run this bridge triggered is in flight. Purely for
    /// reporting — the authority on whether a loop is running is the runner's
    /// process-wide guard, which also covers runs started on the desktop.
    private var loopStartedHere = false

    init(manager: MobileControlManager, autoCode: AutoCodeUpdateService) {
        self.manager = manager
        self.autoCode = autoCode
    }

    // MARK: - MobileFeatureBridge

    /// Handle `loop_*` messages: snapshot / start / stop / history for the
    /// active project's Loop. Each case is the pre-existing body moved
    /// verbatim from the old monolithic `handleInbound` switch (by way of
    /// `MobileControlManager.handleLoop`). `data` is optional so a
    /// manager-triggered synthetic call can pass `nil` for message types that
    /// never decode a payload.
    func handle(type: String, data: Data?) -> Bool {
        switch type {
        case MobileProtocol.Tag.loopStatusList:
            manager?.reply(buildLoopState())
            return true

        case MobileProtocol.Tag.loopStart:
            guard let autoCode else {
                // Not `replyNotConfigured`: that says "Auto-tasks not
                // configured", which is true underneath but reads as a
                // non-sequitur when the user pressed Start on the Loop page.
                manager?.append(.stderr, "loop_start: auto-code service not wired")
                manager?.reply(CommandError(commandId: "loop_start",
                                            message: "The Mac app can't run a loop right now — its auto-code service isn't wired up."))
                return true
            }
            let state = buildLoopState()
            // Refuse for a concrete reason rather than firing a run that the
            // Mac would reject a moment later for the same reason.
            guard state.configured else {
                manager?.append(.stderr, "loop_start: no project or no saved loop config")
                manager?.reply(LoopAck(accepted: false,
                                       message: "No loop is set up for the active project. Create one on the Mac first."))
                return true
            }
            // When a run is already in flight, queue behind it — the runner's
            // `LoopRunQueue` waits instead of rejecting concurrent callers.
            // The PRIMARY loop specifically, not the whole scheduled sweep:
            // this page shows one loop's stages, log tail and history, and a
            // project now has several independent loops. Starting the sweep
            // here would run loops the phone never showed.
            guard let context = manager?.config.flatMap({ cfg in
                      manager?.projectStore.flatMap { WorkspaceRoot.context(config: cfg, projectStore: $0) }
                  }),
                  let projectId = manager?.projectStore?.activeProject?.bundle.id,
                  let primary = LoopEngineConfigStore.primaryLoop(
                      projectRoot: context.projectRoot, projectId: projectId,
                      gitRoot: context.gitRoot) else {
                manager?.append(.stderr, "loop_start: no resolvable project loop")
                manager?.reply(LoopAck(accepted: false,
                                       message: "No loop is set up for the active project. Create one on the Mac first."))
                return true
            }
            // runSingleLoop is @MainActor-sync and spins its own Task; false
            // means the scheduler declined (already busy).
            let started = autoCode.runSingleLoop(loopId: primary.id, trigger: .phone)
            loopStartedHere = started
            manager?.append(started ? .info : .stderr, "loop_start \(started ? "accepted" : "declined by scheduler")")
            let queuedNote = state.running ? " Queued behind the current run." : ""
            manager?.reply(LoopAck(accepted: started,
                                   message: started ? "Loop started.\(queuedNote)" : "The Mac declined to start a run right now."))
            return true

        case MobileProtocol.Tag.loopStartStage:
            guard let req = try? manager?.decoder.decode(LoopStartStage.self, from: data ?? Data()),
                  !req.stageId.isEmpty else {
                manager?.reply(CommandError(commandId: "loop_start_stage",
                                            message: "Malformed loop_start_stage payload."))
                return true
            }
            guard let autoCode else {
                manager?.append(.stderr, "loop_start_stage: auto-code service not wired")
                manager?.reply(CommandError(commandId: "loop_start_stage",
                                            message: "The Mac app can't run a loop right now — its auto-code service isn't wired up."))
                return true
            }
            let state = buildLoopState()
            guard state.configured else {
                manager?.append(.stderr, "loop_start_stage: no project or no saved loop config")
                manager?.reply(LoopAck(accepted: false,
                                       message: "No loop is set up for the active project. Create one on the Mac first."))
                return true
            }
            guard let stage = state.stages.first(where: { $0.stageId == req.stageId }) else {
                manager?.append(.stderr, "loop_start_stage: unknown stage id")
                manager?.reply(LoopAck(accepted: false,
                                       message: "That stage no longer exists — refresh and try again."))
                return true
            }
            // Queue behind an in-flight run when needed — see `loop_start`.
            let started = autoCode.runSingleLoopStage(stageId: req.stageId, trigger: .phone)
            loopStartedHere = started
            manager?.append(started ? .info : .stderr,
                            "loop_start_stage \(started ? "accepted" : "declined by scheduler") — \(stage.name)")
            let queuedNote = state.running ? " Queued behind the current run." : ""
            manager?.reply(LoopAck(accepted: started,
                                   message: started ? "Stage \"\(stage.name)\" started.\(queuedNote)"
                                                    : "The Mac declined to start a run right now."))
            return true

        case MobileProtocol.Tag.loopStop:
            guard let autoCode else {
                manager?.append(.stderr, "loop_stop: auto-code service not wired")
                manager?.reply(CommandError(commandId: "loop_stop",
                                            message: "The Mac app can't stop a loop right now — its auto-code service isn't wired up."))
                return true
            }
            autoCode.stop()
            loopStartedHere = false
            manager?.append(.info, "loop_stop requested from phone")
            manager?.reply(LoopAck(accepted: true, message: "Stop requested."))
            return true

        case MobileProtocol.Tag.loopHistory:
            let limit = (try? manager?.decoder.decode(LoopHistoryRequest.self, from: data ?? Data()))?.limit ?? 15
            manager?.reply(LoopHistoryReply(runs: loopHistory(limit: min(max(limit, 1), 50))))
            return true

        default:
            manager?.append(.info, "Unhandled loop type: \(type)")
            return false
        }
    }

    /// No push-on-change subscriptions exist for Loop today — the phone only
    /// ever pulls (`loop_status_list`), so this is intentionally a no-op.
    /// Kept so the manager can call it unconditionally alongside
    /// `autoTaskBridge?.installPushObservers()`.
    func installPushObservers() {
        // Intentionally empty — see doc comment above.
    }

    // MARK: - State snapshot

    /// Snapshot of the active project's loop. `running` deliberately reads the
    /// runner's PROCESS-WIDE guard rather than anything this bridge owns, so a
    /// run started on the desktop or by the scheduler is reported honestly
    /// instead of appearing idle to the phone.
    private func buildLoopState() -> LoopState {
        guard let config = manager?.config, let projectStore = manager?.projectStore,
              let project = projectStore.activeProject,
              let context = WorkspaceRoot.context(config: config, projectStore: projectStore) else {
            return LoopState(configured: false, projectName: nil, running: false, startedHere: false,
                             iteration: 0, maxIterations: 0, logTail: [], lastStatusSummary: nil,
                             lastFinishedAt: nil, stages: [], queuedCount: 0)
        }
        let projectId = project.bundle.id
        let loopConfig = Self.resolveLoopConfig(projectRoot: context.projectRoot,
                                                projectId: projectId,
                                                gitRoot: context.gitRoot)
        // Stage ids from the detector are re-minted on every snapshot (no
        // saved config) or appended fresh by ensureDefaultStages (saved
        // config missing a default stage) — either way, an id handed to the
        // phone here can already be stale by the time a tap's re-check runs.
        // Only ids that exist in the PERSISTED config are stable enough to
        // target, so unsaved/detector-appended stages get stageId: nil and
        // the phone hides ▶ for exactly those, same as it does for old Macs.
        let savedPrimary = LoopEngineConfigStore.primaryLoop(projectRoot: context.projectRoot,
                                                             projectId: projectId,
                                                             gitRoot: context.gitRoot)
        let savedStageIds = Set(savedPrimary?.config.stages.map(\.id) ?? [])
        let running = context.gitRoot.map { LoopEngineRunner.isRunActive(gitRoot: $0) } ?? false
        let queuedCount = context.gitRoot.map { LoopEngineRunner.queuedRunCount(gitRoot: $0) } ?? 0
        let recent = loopHistory(limit: 1).first

        // `logStore` lives on the auto-code service, not this bridge — Loop
        // runs as the `loopEngineering` Auto Task under the hood, so its live
        // log tail is that task's buffer in the SAME store the Mac Auto Tasks
        // page observes.
        let tail = (autoCode?.logStore.buffers[AutoTask.loopEngineering.rawValue] ?? [])
            .suffix(40)
            .map { "\($0.text)" }

        return LoopState(
            configured: loopConfig != nil,
            projectName: project.bundle.displayName,
            running: running,
            // Cleared whenever a run is not in flight, so a stale "started
            // here" can't outlive the run it described.
            startedHere: running && loopStartedHere,
            // The runner's live iteration count is instance state on a runner
            // this bridge does not own, so it is not reported as a number the
            // phone could misread as authoritative. The log tail carries the
            // per-iteration lines the desktop shows.
            iteration: 0,
            maxIterations: loopConfig?.maxIterations ?? 0,
            logTail: Array(tail),
            lastStatusSummary: recent?.statusSummary,
            lastFinishedAt: recent.map { $0.startedAt + $0.durationSeconds },
            stages: (loopConfig?.stages ?? [])
                .sorted { $0.order < $1.order }
                .map {
                    LoopStageInfo(name: $0.name, kind: $0.kind.rawValue,
                                  severity: $0.severity.rawValue,
                                  enabled: $0.enabled, order: $0.order,
                                  stageId: savedStageIds.contains($0.id) ? $0.id : nil)
                },
            queuedCount: queuedCount
        )
    }

    /// The PRIMARY loop's config as the Mac would actually RUN it — not the raw
    /// saved file.
    ///
    /// Both divergences this used to hand-roll are now inside
    /// `LoopEngineConfigStore.primaryLoop` → `loops`, which every surface
    /// shares: default loops are created when a project has none (so the phone
    /// cannot say "not set up" for a loop the Mac would happily run), and each
    /// loop's own pinned stages are re-pinned (so the phone cannot under-report
    /// stages the desktop shows). Sharing one entry point is what keeps the two
    /// from drifting apart again.
    ///
    /// **The phone still sees ONE loop.** A project now has several independent
    /// loops (Regression / Test / System Check / anything the user added) and
    /// this reports the Primary one only — the pre-existing design commitment,
    /// unchanged here. Picking a loop from the phone needs new wire types in
    /// `SharedProtocol`, so it is deliberately not part of this change; the
    /// scheduled Auto Task runs every scheduled loop regardless of what the
    /// phone shows.
    ///
    /// Writes are possible as a side effect (the shared loader persists a
    /// migration or a newly created default loop), which is intentional and
    /// idempotent — it matches the precedent the UserDefaults→file migration
    /// set, and never invents a config the desktop wouldn't have.
    /// `nonisolated` because it touches no bridge state — only the config
    /// store and the stage detector — which also makes it directly testable
    /// without hopping onto the main actor.
    nonisolated static func resolveLoopConfig(projectRoot: URL?, projectId: String,
                                              gitRoot: URL?) -> LoopEngineConfig? {
        LoopEngineConfigStore.primaryLoop(projectRoot: projectRoot, projectId: projectId,
                                          gitRoot: gitRoot)?.config
    }

    /// Finished runs from the Mac's append-only journal index, scoped to the
    /// project's PRIMARY loop. The journal is written once per run at
    /// completion, so this is history only — live progress comes from the
    /// log tail above. The phone only ever sees one loop's status/history
    /// (the design commitment predating multi-loop support), so this must
    /// filter out any other loop's runs the same way `LoopEngineView`'s own
    /// past-runs list does.
    private func loopHistory(limit: Int) -> [LoopRunSummary] {
        guard let config = manager?.config, let projectStore = manager?.projectStore,
              let project = projectStore.activeProject,
              let context = WorkspaceRoot.context(config: config, projectStore: projectStore) else { return [] }
        let primaryId = LoopEngineConfigStore.primaryLoop(projectRoot: context.projectRoot,
                                                           projectId: project.bundle.id,
                                                           gitRoot: context.gitRoot)?.id
        // Read more than the requested limit — a project's journal
        // interleaves every loop's runs, so filtering down to the Primary
        // loop AFTER limiting would starve the result. Mirrors
        // LoopEngineView.loadPastRuns's identical reasoning. The absolute
        // floor matters for the `limit: 1` call in buildLoopState: a bare
        // 4-run window is emptied by four consecutive non-Primary runs, and
        // the phone would then show no last status at all.
        let candidates = FileLoopRunJournal().recentRuns(root: context.projectRoot,
                                                         limit: max(limit * 4, 20))
        let scoped = candidates.filter { $0.loopId == primaryId || $0.loopId == nil }
        return scoped.prefix(limit).map {
            LoopRunSummary(id: $0.id,
                           startedAt: $0.startedAt.timeIntervalSince1970,
                           durationSeconds: $0.durationSeconds,
                           iterationsUsed: $0.iterationsUsed,
                           statusCode: $0.statusCode,
                           statusSummary: $0.statusSummary,
                           trigger: $0.trigger.rawValue)
        }
    }
}

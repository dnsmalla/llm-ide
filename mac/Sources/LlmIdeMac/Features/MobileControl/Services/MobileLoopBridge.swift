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
    /// Owner of DESKTOP-initiated runs. Without it `loop_stop` reached only
    /// the scheduler's runner, so a run the user started on the Mac kept
    /// going — the phone reported "Stop requested", the run ignored it, and
    /// `loop_status_list` (which reads the process-wide guard, so it sees
    /// desktop runs) kept answering "running". Weak: the bridge must not
    /// keep an app-level service alive.
    weak var runService: LoopRunService?

    /// True while a run this bridge triggered is in flight. Purely for
    /// reporting — the authority on whether a loop is running is the runner's
    /// process-wide guard, which also covers runs started on the desktop.
    private var startedHereTracker = StartedHereTracker()
    private var loopStartedHere: Bool {
        get { startedHereTracker.startedHere }
        set { newValue ? startedHereTracker.markStarted() : startedHereTracker.reset() }
    }

    /// Orders the phone's requests: a Stop cancels a start still awaiting its
    /// snapshot, and a reply computed for an older request than one already
    /// answered is dropped rather than overwriting the newer answer.
    private(set) var requestGate = MobileLoopRequestGate()

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
            let seq = requestGate.issue()
            Task { @MainActor [weak self] in
                guard let self else { return }
                let state = await self.buildLoopState()
                guard self.requestGate.claim(seq, .status) else { return }
                self.manager?.reply(state)
            }
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
            let seq = requestGate.issue()
            let stopGeneration = requestGate.stopGeneration
            Task { @MainActor [weak self] in
                guard let self else { return }
                let state = await self.buildLoopState()
                guard self.requestGate.claim(seq, .start) else { return }
                // A Stop that arrived while the snapshot loaded cancels this start.
                guard self.requestGate.stopGeneration == stopGeneration else {
                    self.manager?.append(.info, "loop_start cancelled by a Stop sent meanwhile")
                    self.manager?.reply(LoopAck(accepted: false, message: MobileLoopRequestGate.stoppedBeforeStart))
                    return
                }
                // Refuse for a concrete reason rather than firing a run that the
                // Mac would reject a moment later for the same reason.
                guard state.configured else {
                    self.manager?.append(.stderr, "loop_start: no project or no saved loop config")
                    self.manager?.reply(LoopAck(accepted: false,
                                           message: "No loop is set up for the active project. Create one on the Mac first."))
                    return
                }
                // When a run is already in flight, queue behind it — the runner's
                // `LoopRunQueue` waits instead of rejecting concurrent callers.
                // The PRIMARY loop specifically, not the whole scheduled sweep:
                // this page shows one loop's stages, log tail and history, and a
                // project now has several independent loops. Starting the sweep
                // here would run loops the phone never showed.
                guard let context = self.manager?.config.flatMap({ cfg in
                          self.manager?.projectStore.flatMap { WorkspaceRoot.context(config: cfg, projectStore: $0) }
                      }),
                      let projectId = self.manager?.projectStore?.activeProject?.bundle.id,
                      let primary = LoopEngineConfigStore.primaryLoop(
                          projectRoot: context.projectRoot, projectId: projectId,
                          gitRoot: context.gitRoot) else {
                    self.manager?.append(.stderr, "loop_start: no resolvable project loop")
                    self.manager?.reply(LoopAck(accepted: false,
                                           message: "No loop is set up for the active project. Create one on the Mac first."))
                    return
                }
                // runSingleLoop is @MainActor-sync and spins its own Task; false
                // means the scheduler declined (already busy).
                let started = autoCode.runSingleLoop(loopId: primary.id, trigger: .phone)
                self.startedHereTracker.noteStart(succeeded: started)
                self.manager?.append(started ? .info : .stderr, "loop_start \(started ? "accepted" : "declined by scheduler")")
                let queuedNote = state.running ? " Queued behind the current run." : ""
                self.manager?.reply(LoopAck(accepted: started,
                                       message: started ? "Loop started.\(queuedNote)" : "The Mac declined to start a run right now."))
            }
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
            let seq = requestGate.issue()
            let stopGeneration = requestGate.stopGeneration
            Task { @MainActor [weak self] in
                guard let self else { return }
                let state = await self.buildLoopState()
                guard self.requestGate.claim(seq, .start) else { return }
                guard self.requestGate.stopGeneration == stopGeneration else {
                    self.manager?.append(.info, "loop_start_stage cancelled by a Stop sent meanwhile")
                    self.manager?.reply(LoopAck(accepted: false, message: MobileLoopRequestGate.stoppedBeforeStart))
                    return
                }
                guard state.configured else {
                    self.manager?.append(.stderr, "loop_start_stage: no project or no saved loop config")
                    self.manager?.reply(LoopAck(accepted: false,
                                           message: "No loop is set up for the active project. Create one on the Mac first."))
                    return
                }
                guard let stage = state.stages.first(where: { $0.stageId == req.stageId }) else {
                    self.manager?.append(.stderr, "loop_start_stage: unknown stage id")
                    self.manager?.reply(LoopAck(accepted: false,
                                           message: "That stage no longer exists — refresh and try again."))
                    return
                }
                // Queue behind an in-flight run when needed — see `loop_start`.
                let started = autoCode.runSingleLoopStage(stageId: req.stageId, trigger: .phone)
                self.startedHereTracker.noteStart(succeeded: started)
                self.manager?.append(started ? .info : .stderr,
                                "loop_start_stage \(started ? "accepted" : "declined by scheduler") — \(stage.name)")
                let queuedNote = state.running ? " Queued behind the current run." : ""
                self.manager?.reply(LoopAck(accepted: started,
                                       message: started ? "Stage \"\(stage.name)\" started.\(queuedNote)"
                                                        : "The Mac declined to start a run right now."))
            }
            return true

        case MobileProtocol.Tag.loopStop:
            guard let autoCode else {
                manager?.append(.stderr, "loop_stop: auto-code service not wired")
                manager?.reply(CommandError(commandId: "loop_stop",
                                            message: "The Mac app can't stop a loop right now — its auto-code service isn't wired up."))
                return true
            }
            // `cancelLoopLane()`, not `stop()`/`cancel()`: stop() also
            // invalidates the Auto Task scheduler timer, and cancel() would
            // kill unrelated Auto Task runs; a loop runs on its own lane.
            requestGate.noteStop()
            autoCode.cancelLoopLane()
            // Also cancel any desktop-initiated run for the active project.
            // `stopAll` rather than the Primary loop's id: the phone only
            // ever shows Primary, but Stop meaning "stop the loop that is
            // running" is the only reading a user has — leaving a different
            // loop's desktop run going would look like Stop did nothing.
            if let projectId = manager?.projectStore?.activeProject?.bundle.id {
                runService?.stopAll(projectId: projectId)
            }
            loopStartedHere = false
            manager?.append(.info, "loop_stop requested from phone")
            manager?.reply(LoopAck(accepted: true, message: "Stop requested."))
            return true

        case MobileProtocol.Tag.loopHistory:
            let limit = (try? manager?.decoder.decode(LoopHistoryRequest.self, from: data ?? Data()))?.limit ?? 15
            Task { @MainActor [weak self] in
                guard let self else { return }
                let runs = await self.loopHistory(limit: min(max(limit, 1), 50))
                self.manager?.reply(LoopHistoryReply(runs: runs))
            }
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

    /// No-op counterpart to `installPushObservers()` — this bridge holds no
    /// Combine subscriptions of its own to cancel (see that method's doc
    /// comment). Kept so the manager can call it unconditionally alongside
    /// `autoTaskBridge?.removePushObservers()`.
    func removePushObservers() {
        // Intentionally empty — no subscriptions to cancel.
    }

    // MARK: - State snapshot

    /// Snapshot of the active project's loop. `running` deliberately reads the
    /// runner's PROCESS-WIDE guard rather than anything this bridge owns, so a
    /// run started on the desktop or by the scheduler is reported honestly
    /// instead of appearing idle to the phone.
    private func buildLoopState() async -> LoopState {
        guard let config = manager?.config, let projectStore = manager?.projectStore,
              let project = projectStore.activeProject,
              let context = WorkspaceRoot.context(config: config, projectStore: projectStore) else {
            return LoopState(configured: false, projectName: nil, running: false, startedHere: false,
                             iteration: 0, maxIterations: 0, logTail: [], lastStatusSummary: nil,
                             lastFinishedAt: nil, stages: [], queuedCount: 0)
        }
        let projectId = project.bundle.id
        let running = context.gitRoot.map { LoopEngineRunner.isRunActive(gitRoot: $0) } ?? false
        let queuedCount = context.gitRoot.map { LoopEngineRunner.queuedRunCount(gitRoot: $0) } ?? 0
        startedHereTracker.observe(running: running)
        // `logStore` lives on the auto-code service, not this bridge — Loop
        // runs as the `loopEngineering` Auto Task under the hood, so its live
        // log tail is that task's buffer in the SAME store the Mac Auto Tasks
        // page observes.
        let tail = (autoCode?.logStore.buffers[AutoTask.loopEngineering.rawValue] ?? [])
            .suffix(40)
            .map { "\($0.text)" }
        let startedHere = running && loopStartedHere
        let projectRoot = context.projectRoot
        let gitRoot = context.gitRoot
        // Config load (first-hit detection + file read) and the journal tail
        // read are disk IO: keep them off the main actor.
        let (primary, recent) = await Task.detached(priority: .userInitiated) {
            Self.loadSnapshot(projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot)
        }.value
        let loopConfig = primary?.config
        return LoopState(
            configured: loopConfig != nil,
            projectName: project.bundle.displayName,
            running: running,
            // Cleared whenever a run is not in flight, so a stale "started
            // here" can't outlive the run it described.
            startedHere: startedHere,
            // The runner's live iteration count is instance state on a runner
            // this bridge does not own, so it is not reported as a number the
            // phone could misread as authoritative. The log tail carries the
            // per-iteration lines the desktop shows.
            iteration: 0,
            maxIterations: loopConfig?.maxIterations ?? 0,
            logTail: Array(tail),
            lastStatusSummary: recent?.statusSummary,
            lastFinishedAt: recent.map { $0.startedAt.timeIntervalSince1970 + $0.durationSeconds },
            // Stage ids come from the one (cached) `primaryLoop` read above, so
            // they are exactly the ids a follow-up `loop_start_stage` resolves.
            stages: (loopConfig?.stages ?? [])
                .sorted { $0.order < $1.order }
                .map {
                    LoopStageInfo(name: $0.name, kind: $0.kind.rawValue,
                                  severity: $0.severity.rawValue,
                                  enabled: $0.enabled, order: $0.order,
                                  stageId: $0.id)
                },
            queuedCount: queuedCount
        )
    }

    /// One config load plus one journal tail read, both synchronous disk IO.
    /// `nonisolated` so it runs off the main actor and is directly testable.
    nonisolated static func loadSnapshot(projectRoot: URL?, projectId: String,
                                         gitRoot: URL?) -> (primary: LoopDefinition?, recent: LoopRunIndexEntry?) {
        let primary = LoopEngineConfigStore.primaryLoop(projectRoot: projectRoot, projectId: projectId,
                                                        gitRoot: gitRoot)
        let recent = projectRoot.flatMap {
            scopedHistory(root: $0, primaryId: primary?.id, limit: 1).first
        }
        return (primary, recent)
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
    private func loopHistory(limit: Int) async -> [LoopRunSummary] {
        guard let config = manager?.config, let projectStore = manager?.projectStore,
              let project = projectStore.activeProject,
              let context = WorkspaceRoot.context(config: config, projectStore: projectStore) else { return [] }
        let projectId = project.bundle.id
        let root = context.projectRoot
        let gitRoot = context.gitRoot
        let entries = await Task.detached(priority: .userInitiated) { () -> [LoopRunIndexEntry] in
            let primaryId = LoopEngineConfigStore.primaryLoop(projectRoot: root, projectId: projectId,
                                                              gitRoot: gitRoot)?.id
            return Self.scopedHistory(root: root, primaryId: primaryId, limit: limit)
        }.value
        return entries.map {
            LoopRunSummary(id: $0.id,
                           startedAt: $0.startedAt.timeIntervalSince1970,
                           durationSeconds: $0.durationSeconds,
                           iterationsUsed: $0.iterationsUsed,
                           statusCode: $0.statusCode,
                           statusSummary: $0.statusSummary,
                           trigger: $0.trigger.rawValue)
        }
    }

    /// Tail-read journal index entries scoped to the Primary loop (or
    /// pre-multi-loop entries with no loop id).
    nonisolated static func scopedHistory(root: URL?, primaryId: String?, limit: Int) -> [LoopRunIndexEntry] {
        guard let root else { return [] }
        let candidates = FileLoopRunJournal().recentRuns(root: root, limit: max(limit * 4, 20))
        return Array(candidates.filter { $0.loopId == primaryId || $0.loopId == nil }.prefix(limit))
    }
}

/// Tracks whether the run the phone started is still in flight. The flag is
/// cleared once a run has been observed ending — not merely "not running" —
/// because a just-queued run is briefly inactive.
struct StartedHereTracker {
    private(set) var startedHere = false
    private var sawRunning = false

    mutating func markStarted() { startedHere = true; sawRunning = false }
    /// Only a start that happened resets the tracker — a declined one must not
    /// forget a phone run already in flight.
    mutating func noteStart(succeeded: Bool) { if succeeded { markStarted() } }
    mutating func reset() { startedHere = false; sawRunning = false }
    mutating func observe(running: Bool) {
        if running { sawRunning = true } else if sawRunning { reset() }
    }
}

/// Ordering for the phone's `loop_*` requests (pure, so it is testable).
///
/// - `stopGeneration` rises on every `loop_stop`; a start captures it before
///   its await and re-checks after, so a Stop that arrived meanwhile wins.
/// - Each status / start request takes a sequence number; `claim` delivers a
///   reply only when no NEWER request on the same channel was answered first.
///   Dropped on the Mac, so the wire format is unchanged.
struct MobileLoopRequestGate {
    enum Channel: Hashable { case status, start }
    static let stoppedBeforeStart = "Stopped before it started."

    private(set) var stopGeneration = 0
    private var nextSeq = 0
    private var answered: [Channel: Int] = [:]

    mutating func noteStop() { stopGeneration += 1 }
    mutating func issue() -> Int { nextSeq += 1; return nextSeq }
    /// True (and records the answer) when `seq` is newer than the last reply
    /// sent on `channel`; false means a newer request already answered.
    mutating func claim(_ seq: Int, _ channel: Channel) -> Bool {
        guard seq > (answered[channel] ?? 0) else { return false }
        answered[channel] = seq
        return true
    }
}

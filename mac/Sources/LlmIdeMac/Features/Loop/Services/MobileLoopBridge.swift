import Foundation

/// Serves the `loop_*` slice of the mobile protocol on behalf of the mobile
/// manager — see `MobileFeatureBridge`'s doc comment for why the manager holds
/// this behind a protocol rather than this concrete type.
///
/// Lives in Features/Loop, not Features/MobileControl: it is the Loop's half of
/// the phone seam. It reaches the manager only through `MobileBridgeHosting`
/// and the AutoTask scheduler only through `LoopLaneControlling` (both in
/// Core/Contracts), so it names no MobileControl or AutoTask type and needs no
/// `SharedProtocol` import — the host decodes `MobileLoopRequest` from the wire
/// and encodes `MobileLoopReply` back onto it. That is what lets this file
/// compile in a build with `auto_tasks` on and `mobile_sync` off, where
/// `SharedProtocol` is not linked at all.
///
/// The phone is a CONTROL SURFACE only — no part of running a loop lives on
/// it or in this bridge. Starting one delegates to the Mac's existing
/// `loopEngineering` auto task (via its loop lane), which is the single path
/// that already wires every dependency a run needs (stage repairer, regression
/// sweep, skill executor, journal) and produces a journal record identical to
/// a scheduled run's. Reimplementing that here would have been a second runner
/// construction to keep in step with the first.
@MainActor
final class MobileLoopBridge: MobileFeatureBridge {
    weak var host: (any MobileBridgeHosting)?
    /// AutoTask's loop lane. Strong, as the concrete service reference was
    /// before: the bridge is installed for the app's lifetime and the service
    /// outlives it anyway.
    var loopLane: (any LoopLaneControlling)?
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

    /// Why a start the phone queued must NOT run now, or nil. Pure so a test can pin every case.
    nonisolated static func executionRefusal(switchAllowed: Bool, deniedMessage: String,
                                             projectAtReceipt: String?, projectNow: String?) -> String? {
        guard switchAllowed else { return deniedMessage }
        guard projectAtReceipt == projectNow else {
            return "The active project changed on your Mac while this was waiting, so nothing started. Ask again."
        }
        return nil
    }

    private func executionRefusal(projectAtReceipt: String?) -> String? {
        Self.executionRefusal(switchAllowed: loopControlAllowed, deniedMessage: loopControlDeniedMessage,
                              projectAtReceipt: projectAtReceipt,
                              projectNow: host?.projectStore?.activeProject?.bundle.id)
    }

    init(host: any MobileBridgeHosting, loopLane: any LoopLaneControlling) {
        self.host = host
        self.loopLane = loopLane
    }

    // MARK: - MobileFeatureBridge

    /// Handle `loop_*` messages: snapshot / start / stop / history for the
    /// active project's Loop. `data` is optional so a manager-triggered
    /// synthetic call can pass `nil` for message types that never decode a
    /// payload.
    func handle(type: String, data: Data?) -> Bool {
        guard let request = host?.decodeLoopRequest(type: type, data: data) else {
            host?.logInfo("Unhandled loop type: \(type)")
            return false
        }
        switch request {
        case .status:
            let seq = requestGate.issue()
            Task { @MainActor [weak self] in
                guard let self else { return }
                let state = await self.buildLoopState()
                guard self.requestGate.claim(seq, .status) else { return }
                self.host?.sendLoopReply(.state(state))
            }
            return true

        case .start:
            guard loopControlAllowed else {
                host?.sendLoopReply(.ack(accepted: false, message: loopControlDeniedMessage))
                return true
            }
            guard let loopLane else {
                // Not `replyNotConfigured`: that says "Auto-tasks not
                // configured", which is true underneath but reads as a
                // non-sequitur when the user pressed Start on the Loop page.
                host?.logError("loop_start: auto-code service not wired")
                host?.replyCommandError(commandId: "loop_start",
                                        message: "The Mac app can't run a loop right now — its auto-code service isn't wired up.")
                return true
            }
            let seq = requestGate.issue()
            let stopGeneration = requestGate.stopGeneration
            let projectAtReceipt = host?.projectStore?.activeProject?.bundle.id
            Task { @MainActor [weak self] in
                guard let self else { return }
                let state = await self.buildLoopState()
                guard self.requestGate.claim(seq, .start) else { return }
                // A Stop that arrived while the snapshot loaded cancels this start.
                guard self.requestGate.stopGeneration == stopGeneration else {
                    self.host?.logInfo("loop_start cancelled by a Stop sent meanwhile")
                    self.host?.sendLoopReply(.ack(accepted: false, message: MobileLoopRequestGate.stoppedBeforeStart))
                    return
                }
                // Re-validate at EXECUTION time: the switch may have been turned off, or the project changed,
                // while the snapshot loaded. Checking only at receipt let a queued request run against a
                // project the phone never asked about.
                if let why = self.executionRefusal(projectAtReceipt: projectAtReceipt) {
                    self.host?.logInfo("loop_start refused at execution: \(why)")
                    self.host?.sendLoopReply(.ack(accepted: false, message: why))
                    return
                }
                // Refuse for a concrete reason rather than firing a run that the
                // Mac would reject a moment later for the same reason.
                guard state.configured else {
                    self.host?.logError("loop_start: no project or no saved loop config")
                    self.host?.sendLoopReply(.ack(accepted: false,
                                                  message: "No loop is set up for the active project. Create one on the Mac first."))
                    return
                }
                // When a run is already in flight, queue behind it — the runner's
                // `LoopRunQueue` waits instead of rejecting concurrent callers.
                // The PRIMARY loop specifically, not the whole scheduled sweep:
                // this page shows one loop's stages, log tail and history, and a
                // project now has several independent loops. Starting the sweep
                // here would run loops the phone never showed.
                guard let context = self.host?.config.flatMap({ cfg in
                          self.host?.projectStore.flatMap { WorkspaceRoot.context(config: cfg, projectStore: $0) }
                      }),
                      let projectId = self.host?.projectStore?.activeProject?.bundle.id,
                      let primary = LoopEngineConfigStore.primaryLoop(
                          projectRoot: context.projectRoot, projectId: projectId,
                          gitRoot: context.gitRoot) else {
                    self.host?.logError("loop_start: no resolvable project loop")
                    self.host?.sendLoopReply(.ack(accepted: false,
                                                  message: "No loop is set up for the active project. Create one on the Mac first."))
                    return
                }
                // Synchronous on the main actor and spins its own Task; false
                // means the scheduler declined (already busy).
                let started = loopLane.runSingleLoopFromPhone(loopId: primary.id)
                self.startedHereTracker.noteStart(succeeded: started)
                self.log(started, "loop_start \(started ? "accepted" : "declined by scheduler")")
                let queuedNote = state.running ? " Queued behind the current run." : ""
                self.host?.sendLoopReply(.ack(accepted: started,
                                              message: started ? "Loop started.\(queuedNote)" : "The Mac declined to start a run right now."))
            }
            return true

        case .startStage(let stageId):
            guard loopControlAllowed else {
                host?.sendLoopReply(.ack(accepted: false, message: loopControlDeniedMessage))
                return true
            }
            guard let stageId, !stageId.isEmpty else {
                host?.replyCommandError(commandId: "loop_start_stage",
                                        message: "Malformed loop_start_stage payload.")
                return true
            }
            guard let loopLane else {
                host?.logError("loop_start_stage: auto-code service not wired")
                host?.replyCommandError(commandId: "loop_start_stage",
                                        message: "The Mac app can't run a loop right now — its auto-code service isn't wired up.")
                return true
            }
            let seq = requestGate.issue()
            let stopGeneration = requestGate.stopGeneration
            let projectAtReceipt = host?.projectStore?.activeProject?.bundle.id
            Task { @MainActor [weak self] in
                guard let self else { return }
                let state = await self.buildLoopState()
                guard self.requestGate.claim(seq, .start) else { return }
                guard self.requestGate.stopGeneration == stopGeneration else {
                    self.host?.logInfo("loop_start_stage cancelled by a Stop sent meanwhile")
                    self.host?.sendLoopReply(.ack(accepted: false, message: MobileLoopRequestGate.stoppedBeforeStart))
                    return
                }
                if let why = self.executionRefusal(projectAtReceipt: projectAtReceipt) {
                    self.host?.logInfo("loop_start_stage refused at execution: \(why)")
                    self.host?.sendLoopReply(.ack(accepted: false, message: why))
                    return
                }
                guard state.configured else {
                    self.host?.logError("loop_start_stage: no project or no saved loop config")
                    self.host?.sendLoopReply(.ack(accepted: false,
                                                  message: "No loop is set up for the active project. Create one on the Mac first."))
                    return
                }
                guard let stage = state.stages.first(where: { $0.stageId == stageId }) else {
                    self.host?.logError("loop_start_stage: unknown stage id")
                    self.host?.sendLoopReply(.ack(accepted: false,
                                                  message: "That stage no longer exists — refresh and try again."))
                    return
                }
                // Queue behind an in-flight run when needed — see `loop_start`.
                let started = loopLane.runSingleLoopStageFromPhone(stageId: stageId)
                self.startedHereTracker.noteStart(succeeded: started)
                self.log(started,
                         "loop_start_stage \(started ? "accepted" : "declined by scheduler") — \(stage.name)")
                let queuedNote = state.running ? " Queued behind the current run." : ""
                self.host?.sendLoopReply(.ack(accepted: started,
                                              message: started ? "Stage \"\(stage.name)\" started.\(queuedNote)"
                                                               : "The Mac declined to start a run right now."))
            }
            return true

        case .stop:
            guard let loopLane else {
                host?.logError("loop_stop: auto-code service not wired")
                host?.replyCommandError(commandId: "loop_stop",
                                        message: "The Mac app can't stop a loop right now — its auto-code service isn't wired up.")
                return true
            }
            // `cancelLoopLane()`, not the service's `stop()`/`cancel()`: stop()
            // also invalidates the Auto Task scheduler timer, and cancel() would
            // kill unrelated Auto Task runs; a loop runs on its own lane.
            requestGate.noteStop()
            loopLane.cancelLoopLane()
            // Also cancel any desktop-initiated run for the active project.
            // `stopAll` rather than the Primary loop's id: the phone only
            // ever shows Primary, but Stop meaning "stop the loop that is
            // running" is the only reading a user has — leaving a different
            // loop's desktop run going would look like Stop did nothing.
            if let projectId = host?.projectStore?.activeProject?.bundle.id {
                runService?.stopAll(projectId: projectId)
            }
            loopStartedHere = false
            host?.logInfo("loop_stop requested from phone")
            host?.sendLoopReply(.ack(accepted: true, message: "Stop requested."))
            return true

        case .history(let requested):
            let limit = requested ?? 15
            Task { @MainActor [weak self] in
                guard let self else { return }
                let runs = await self.loopHistory(limit: min(max(limit, 1), 50))
                self.host?.sendLoopReply(.history(runs))
            }
            return true
        }
    }

    /// Re-read on every request: a phone may hold an old capability list after the switch flips off.
    /// Stop is deliberately ungated so a phone can always halt a run. Fails
    /// closed: no host means no switch to consult.
    private var loopControlAllowed: Bool {
        host?.isPhoneAccessAllowed(.loopControl) == true
    }

    private var loopControlDeniedMessage: String {
        host?.phoneAccessDeniedMessage(.loopControl) ?? ""
    }

    /// Info line on success, error line otherwise — the scheduler declining a
    /// start is worth the red line it always got.
    private func log(_ succeeded: Bool, _ text: String) {
        if succeeded {
            host?.logInfo(text)
        } else {
            host?.logError(text)
        }
    }

    /// No push-on-change subscriptions exist for Loop today — the phone only
    /// ever pulls (`loop_status_list`), so this is intentionally a no-op.
    /// Kept so the manager can call it unconditionally alongside the Auto
    /// Task bridge's `installPushObservers()`.
    func installPushObservers() {
        // Intentionally empty — see doc comment above.
    }

    /// No-op counterpart to `installPushObservers()` — this bridge holds no
    /// Combine subscriptions of its own to cancel (see that method's doc
    /// comment). Kept so the manager can call it unconditionally alongside the
    /// Auto Task bridge's `removePushObservers()`.
    func removePushObservers() {
        // Intentionally empty — no subscriptions to cancel.
    }

    // MARK: - State snapshot

    /// Snapshot of the active project's loop. `running` deliberately reads the
    /// runner's PROCESS-WIDE guard rather than anything this bridge owns, so a
    /// run started on the desktop or by the scheduler is reported honestly
    /// instead of appearing idle to the phone.
    private func buildLoopState() async -> MobileLoopReply.State {
        guard let config = host?.config, let projectStore = host?.projectStore,
              let project = projectStore.activeProject,
              let context = WorkspaceRoot.context(config: config, projectStore: projectStore) else {
            return MobileLoopReply.State(configured: false, projectName: nil, running: false, startedHere: false,
                                         iteration: 0, maxIterations: 0, logTail: [], lastStatusSummary: nil,
                                         lastFinishedAt: nil, stages: [], queuedCount: 0)
        }
        let projectId = project.bundle.id
        let running = context.gitRoot.map { LoopEngineRunner.isRunActive(gitRoot: $0) } ?? false
        let queuedCount = context.gitRoot.map { LoopEngineRunner.queuedRunCount(gitRoot: $0) } ?? 0
        startedHereTracker.observe(running: running)
        // The log buffer lives on the auto-code service, not this bridge — Loop
        // runs as the `loopEngineering` Auto Task under the hood, so its live
        // log tail is that task's buffer in the SAME store the Mac Auto Tasks
        // page observes.
        // Raw text only here; redaction runs in the detached task below
        // (the redactor's regexes are too slow for the main actor on a long line).
        let rawTail = Array((loopLane?.loopLaneLogTexts ?? []).suffix(40))
        // No host means no phone to send to; redact everything away rather
        // than fall back to sending raw text.
        let redact = host?.phoneTextRedactor ?? { _ in "" }
        let startedHere = running && loopStartedHere
        let projectRoot = context.projectRoot
        let gitRoot = context.gitRoot
        // Config load (first-hit detection + file read) and the journal tail
        // read are disk IO, and redacting the log tail + the agent-written
        // summary is regex work over free text: keep all of it off the main actor.
        let (primary, recent, tail, redactedSummary) = await Task.detached(priority: .userInitiated) {
            () -> (LoopDefinition?, LoopRunIndexEntry?, [String], String?) in
            let snap = Self.loadSnapshot(projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot)
            return (snap.primary, snap.recent, rawTail.map { redact($0) },
                    snap.recent.map { redact($0.statusSummary) })
        }.value
        let loopConfig = primary?.config
        return MobileLoopReply.State(
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
            logTail: tail,
            // Agent-written free text, redacted like the log tail (off main, above).
            lastStatusSummary: redactedSummary,
            lastFinishedAt: recent.map { $0.startedAt.timeIntervalSince1970 + $0.durationSeconds },
            // Stage ids come from the one (cached) `primaryLoop` read above, so
            // they are exactly the ids a follow-up `loop_start_stage` resolves.
            stages: (loopConfig?.stages ?? [])
                .sorted { $0.order < $1.order }
                .map {
                    MobileLoopReply.StageInfo(name: $0.name, kind: $0.kind.rawValue,
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
    private func loopHistory(limit: Int) async -> [MobileLoopReply.RunSummary] {
        guard let config = host?.config, let projectStore = host?.projectStore,
              let project = projectStore.activeProject,
              let context = WorkspaceRoot.context(config: config, projectStore: projectStore) else { return [] }
        let projectId = project.bundle.id
        let root = context.projectRoot
        let gitRoot = context.gitRoot
        let redact = host?.phoneTextRedactor ?? { _ in "" }
        let entries = await Task.detached(priority: .userInitiated) { () -> [MobileLoopReply.RunSummary] in
            let primaryId = LoopEngineConfigStore.primaryLoop(projectRoot: root, projectId: projectId,
                                                              gitRoot: gitRoot)?.id
            // Redacted here, still off the main actor: a run's summary is
            // agent-written free text and can quote a secret it saw.
            return Self.scopedHistory(root: root, primaryId: primaryId, limit: limit).map {
                MobileLoopReply.RunSummary(id: $0.id,
                                           startedAt: $0.startedAt.timeIntervalSince1970,
                                           durationSeconds: $0.durationSeconds,
                                           iterationsUsed: $0.iterationsUsed,
                                           statusCode: $0.statusCode,
                                           statusSummary: redact($0.statusSummary),
                                           trigger: $0.trigger.rawValue)
            }
        }.value
        return entries
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

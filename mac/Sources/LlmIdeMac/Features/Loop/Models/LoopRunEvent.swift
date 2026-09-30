import Foundation

/// One line of a run's crash-safe event log
/// (`<Application Support>/loop-events/<root hash>/<runId>.jsonl`, outside the
/// project so `RepairScopeGuard`'s protected `system/loop-runs/**` never sees it).
///
/// The final `LoopRunRecord` is only written when a run finishes, so a crash or
/// force-quit used to leave nothing behind. Events are appended (and flushed)
/// as they happen; at the next launch a log that has a `started` event but no
/// final record is turned into an `.aborted` record (`LoopRunEvent.reconstruct`).
struct LoopRunEvent: Codable, Equatable {
    /// Open string rather than an enum so a newer build's event kinds never
    /// make an older reader drop the line.
    enum Kind {
        static let started = "started"
        static let iterationStarted = "iteration_started"
        static let stageStarted = "stage_started"
        static let stageFinished = "stage_finished"
        static let repairRequested = "repair_requested"
        static let repairReplied = "repair_replied"
        static let verdict = "verdict"
    }

    /// Payload of the `started` event — everything a reconstructed record needs.
    struct Start: Codable, Equatable {
        var id: String
        var projectId: String?
        var trigger: LoopRunTrigger
        var gitRoot: String
        var startedAt: Date
        var config: LoopRunConfigSnapshot
        var loopId: String?
        var loopName: String?
    }

    var kind: String
    var at: Date
    var iteration: Int?
    var stageId: String?
    var stageName: String?
    var detail: String?
    var attempt: LoopStageAttempt?
    var start: Start?
    var statusCode: String?

    init(kind: String, at: Date = Date(), iteration: Int? = nil, stageId: String? = nil,
         stageName: String? = nil, detail: String? = nil, attempt: LoopStageAttempt? = nil,
         start: Start? = nil, statusCode: String? = nil) {
        self.kind = kind
        self.at = at
        self.iteration = iteration
        self.stageId = stageId
        self.stageName = stageName
        self.detail = detail
        self.attempt = attempt
        self.start = start
        self.statusCode = statusCode
    }

    /// Builds the `.aborted` record for a run whose log never reached a final
    /// record. Returns nil when the log has no readable `started` event.
    static func reconstruct(from events: [LoopRunEvent]) -> LoopRunRecord? {
        guard let start = events.first(where: { $0.kind == Kind.started })?.start else { return nil }
        var iterations: [LoopIterationRecord] = []
        for event in events {
            switch event.kind {
            case Kind.iterationStarted:
                iterations.append(LoopIterationRecord(index: event.iteration ?? iterations.count + 1))
            case Kind.stageFinished:
                guard let attempt = event.attempt else { continue }
                if iterations.isEmpty { iterations.append(LoopIterationRecord(index: event.iteration ?? 1)) }
                iterations[iterations.count - 1].attempts.append(attempt)
            default:
                break
            }
        }
        let lastEvent = events.map(\.at).max() ?? start.startedAt
        return LoopRunRecord(
            id: start.id, projectId: start.projectId, trigger: start.trigger,
            gitRoot: start.gitRoot, startedAt: start.startedAt, endedAt: max(lastEvent, start.startedAt),
            iterationsUsed: iterations.last?.index ?? 0, config: start.config,
            iterations: iterations, statusCode: LoopEngineStatus.aborted.code,
            statusSummary: "Aborted — app quit or crashed",
            loopId: start.loopId, loopName: start.loopName)
    }
}

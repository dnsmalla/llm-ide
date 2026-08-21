import Foundation

// MARK: - Loop messages
//
// The iPhone is a REMOTE CONTROL for the Loop, not a second implementation of
// it: every message here either asks the Mac for a snapshot or asks it to
// start/stop. Nothing about how a loop runs — stage order, repairs, budgets,
// templates — crosses this boundary, because all of that work stays in the Mac
// app where the editors and the wizard live.
//
// Starting a loop from the phone routes through the Mac's existing
// `loopEngineering` auto task rather than constructing a runner for the phone.
// That reuses the one code path that already wires every dependency
// (repairer, regression sweep, skill executor, journal), and it means a
// phone-triggered run is indistinguishable from a scheduled one — same config,
// same journal record.

/// One stage of the active project's loop config, flattened for display.
/// Deliberately read-only: the phone lists stages so a run is legible, and
/// editing them is a Mac-side job.
public struct LoopStageInfo: Codable, Equatable, Identifiable {
    public let name: String
    /// `LoopStage.Kind` raw value — "regressionSweep" | "shellCommand" | …
    public let kind: String
    /// `LoopStageSeverity` raw value — whether a failure blocks the run.
    public let severity: String
    public let enabled: Bool
    public let order: Int
    public var id: String { "\(order)-\(name)" }

    public init(name: String, kind: String, severity: String, enabled: Bool, order: Int) {
        self.name = name
        self.kind = kind
        self.severity = severity
        self.enabled = enabled
        self.order = order
    }
}

/// Request the current Loop snapshot.
public struct LoopStatusList: Codable, Equatable {
    public let type = MobileProtocol.Tag.loopStatusList
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

public struct LoopState: Codable, Equatable {
    public let type = MobileProtocol.Tag.loopState
    /// False when there is no active project, or the project has no saved loop
    /// config yet — the phone shows "set this up on the Mac" rather than an
    /// empty start button that would fail.
    public let configured: Bool
    public let projectName: String?
    /// A run is in flight for this project's git root. True for runs started
    /// on the MAC as well as from the phone: it reads the runner's
    /// process-wide guard, not a phone-owned instance, so the phone can never
    /// claim the loop is idle while the desktop is mid-run.
    public let running: Bool
    /// Set when this run was triggered from a phone. `running && !startedHere`
    /// means the desktop (or the scheduler) started it — the phone can still
    /// watch and stop it, it just did not begin it.
    public let startedHere: Bool
    public let iteration: Int
    public let maxIterations: Int
    /// Live log tail from the Mac's own per-task log store — the same lines the
    /// desktop Auto Tasks page shows, newest last.
    public let logTail: [String]
    /// One-line terminal status of the most recent finished run.
    public let lastStatusSummary: String?
    public let lastFinishedAt: Double?
    public let stages: [LoopStageInfo]

    public init(configured: Bool, projectName: String?, running: Bool, startedHere: Bool,
                iteration: Int, maxIterations: Int, logTail: [String],
                lastStatusSummary: String?, lastFinishedAt: Double?, stages: [LoopStageInfo]) {
        self.configured = configured
        self.projectName = projectName
        self.running = running
        self.startedHere = startedHere
        self.iteration = iteration
        self.maxIterations = maxIterations
        self.logTail = logTail
        self.lastStatusSummary = lastStatusSummary
        self.lastFinishedAt = lastFinishedAt
        self.stages = stages
    }
    private enum CodingKeys: String, CodingKey {
        case type, configured, projectName, running, startedHere, iteration, maxIterations
        case logTail, lastStatusSummary, lastFinishedAt, stages
    }
}

/// Start the active project's loop now.
public struct LoopStart: Codable, Equatable {
    public let type = MobileProtocol.Tag.loopStart
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

/// Stop the in-flight run.
public struct LoopStop: Codable, Equatable {
    public let type = MobileProtocol.Tag.loopStop
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

/// Answer to start/stop. `accepted: false` is a normal outcome, not an error —
/// most often a run is already in flight for this working tree, which the Mac
/// refuses process-wide so two runs can never repair the same tree at once.
public struct LoopAck: Codable, Equatable {
    public let type = MobileProtocol.Tag.loopAck
    public let accepted: Bool
    public let message: String
    public init(accepted: Bool, message: String) {
        self.accepted = accepted
        self.message = message
    }
    private enum CodingKeys: String, CodingKey { case type, accepted, message }
}

/// One finished run, from the Mac's append-only journal index.
public struct LoopRunSummary: Codable, Equatable, Identifiable {
    public let id: String
    public let startedAt: Double
    public let durationSeconds: Double
    public let iterationsUsed: Int
    /// `LoopEngineStatus` status code — "success" | "givenUp" | "blocked" | …
    public let statusCode: String
    public let statusSummary: String
    /// `LoopRunTrigger` raw value — how the run was started.
    public let trigger: String

    public init(id: String, startedAt: Double, durationSeconds: Double, iterationsUsed: Int,
                statusCode: String, statusSummary: String, trigger: String) {
        self.id = id
        self.startedAt = startedAt
        self.durationSeconds = durationSeconds
        self.iterationsUsed = iterationsUsed
        self.statusCode = statusCode
        self.statusSummary = statusSummary
        self.trigger = trigger
    }
}

public struct LoopHistoryRequest: Codable, Equatable {
    public let type = MobileProtocol.Tag.loopHistory
    public let limit: Int?
    public init(limit: Int? = nil) { self.limit = limit }
    private enum CodingKeys: String, CodingKey { case type, limit }
}

public struct LoopHistoryReply: Codable, Equatable {
    public let type = MobileProtocol.Tag.loopHistoryReply
    public let runs: [LoopRunSummary]
    public init(runs: [LoopRunSummary]) { self.runs = runs }
    private enum CodingKeys: String, CodingKey { case type, runs }
}

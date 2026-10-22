import Foundation

/// An inbound `loop_*` phone request, decoded by `MobileBridgeHosting`.
///
/// Foundation-only for the same reason as `MobileAutoTaskRequest`:
/// `MobileLoopBridge` (Features/Loop) compiles whenever `auto_tasks` does,
/// `SharedProtocol` only with `mobile_sync`.
enum MobileLoopRequest: Equatable {
    case status
    case start
    /// Nil when the frame did not decode. An empty id is passed through as-is;
    /// the bridge treats it as malformed too.
    case startStage(stageId: String?)
    case stop
    /// Nil when the frame carried no (decodable) limit; the bridge applies its default.
    case history(limit: Int?)
}

/// An outbound Loop reply, encoded into its wire type by
/// `MobileBridgeHosting.sendLoopReply`. Field-for-field mirrors of the
/// `SharedProtocol` messages.
enum MobileLoopReply: Equatable {
    case state(State)
    case ack(accepted: Bool, message: String)
    case history([RunSummary])

    /// The active project's Primary loop (wire: `LoopState`).
    struct State: Equatable {
        let configured: Bool
        let projectName: String?
        let running: Bool
        let startedHere: Bool
        let iteration: Int
        let maxIterations: Int
        let logTail: [String]
        let lastStatusSummary: String?
        /// Seconds since 1970.
        let lastFinishedAt: Double?
        let stages: [StageInfo]
        let queuedCount: Int
    }

    /// Wire: `LoopStageInfo`.
    struct StageInfo: Equatable {
        let name: String
        let kind: String
        let severity: String
        let enabled: Bool
        let order: Int
        let stageId: String?
    }

    /// One finished run (wire: `LoopRunSummary`).
    struct RunSummary: Equatable {
        let id: String
        /// Seconds since 1970.
        let startedAt: Double
        let durationSeconds: Double
        let iterationsUsed: Int
        let statusCode: String
        let statusSummary: String
        let trigger: String
    }
}

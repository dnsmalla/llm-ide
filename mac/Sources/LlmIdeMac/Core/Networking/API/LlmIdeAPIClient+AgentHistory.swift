import Foundation

// MARK: - Agent history (storage report, retention, clear, compact)
//
// Server: extension/routes/agent-history.mjs, shapes in
// schema/http/agent-history.schema.json. Always on (no feature gate). A real
// clear needs the `previewId` of a dry run for the same scope and cutoff; the
// server refuses with 400 PREVIEW_EXPIRED / PREVIEW_INVALID or 409 preview_stale,
// and compact refuses with 409 busy, 507 disk_space or 503 AGENT_STORE_UNAVAILABLE.
// Those arrive as `APIError.http(status:code:message:details:)`.

extension LlmIdeAPIClient {

    /// Per-request timeout for the calls that can run long on a large store: clear (both steps)
    /// and compact. The OS page's wait is longer than this (ui/os-view `hosts.ts`), and the bridge's
    /// total deadline is shorter (`SystemBridge.storageDeadline`).
    static let longCallTimeout: TimeInterval = 120

    /// The two scopes a clear accepts: `raw` deletes raw rows and keeps the daily
    /// rollups; `all` also deletes the rollups.
    public enum AgentHistoryClearScope: String, Codable, CaseIterable, Sendable {
        case raw
        case all
    }

    /// One data group of the storage report. `agent_history` carries bytes (an
    /// approximation) and the clear/compact actions; the other groups carry rows.
    public struct StorageGroup: Codable, Equatable, Identifiable, Sendable {
        public let key: String
        public let label: String
        public let rows: Int
        public let bytes: Int?
        public let bytesApprox: Bool?
        public let lastCleanedAt: String?
        public let retentionDays: Int?
        public let actions: [String]

        public var id: String { key }
        public var canClear: Bool { actions.contains("clear") }
        public var canCompact: Bool { actions.contains("compact") }
    }

    /// The agent store's raw/rollup summary. Null when the store is down.
    public struct AgentHistorySummary: Codable, Equatable, Sendable {
        public let rawFromDay: String?
        public let rawRows: Int
        public let rolledDays: Int
        public let oldestDay: String?
        public let quarantinedAt: String?
        public let droppedRows: Int
        public let watermark: String?
    }

    public struct AgentStoreHealth: Codable, Equatable, Sendable {
        public let health: String   // "ok" | "degraded" | "down"
        public let state: String    // "closed" | "ok" | "down"
    }

    /// GET /kb/storage.
    public struct StorageReport: Codable, Equatable, Sendable {
        public let generatedAt: String
        public let groups: [StorageGroup]
        public let agentHistory: AgentHistorySummary?
        public let agentStore: AgentStoreHealth
        /// Counts from the last shadow comparisons; absent when the store could not be read or the server is older.
        public let shadow: ShadowReport?

        /// The agent history group, when the server sent one.
        public var agentHistoryGroup: StorageGroup? {
            groups.first { $0.key == "agent_history" }
        }
    }

    /// The `shadow` block of the storage report: one section per comparison. Only the state and time are read; the
    /// per-comparison counts are for diagnostics and stay in the wire shape.
    public struct ShadowReport: Codable, Equatable, Sendable {
        public struct Section: Codable, Equatable, Sendable {
            public let state: String
            public let at: String?
        }
        public let usage: Section?
        public let noteIndex: Section?
    }

    /// GET and PUT /kb/agent-history/settings. `retentionDays` is clamped by the
    /// server to `min`...`max`.
    public struct AgentHistorySettings: Codable, Equatable, Sendable {
        public let retentionDays: Int
        public let rollupKeepDays: Int
        public let min: Int
        public let max: Int
    }

    /// Row counts per table, as the clear reports them.
    public struct AgentHistoryClearCounts: Codable, Equatable, Sendable {
        public let agentRuns: Int
        public let agentToolEvents: Int
        public let turnComposition: Int
        public let agentDaily: Int
        public let agentDailyTools: Int

        enum CodingKeys: String, CodingKey {
            case agentRuns = "agent_runs"
            case agentToolEvents = "agent_tool_events"
            case turnComposition = "turn_composition"
            case agentDaily = "agent_daily"
            case agentDailyTools = "agent_daily_tools"
        }
    }

    /// POST /kb/agent-history/clear. One model for both 200 answers: a dry run
    /// (`dryRun: true`, `wouldDelete`, `previewId`, `expiresAt`) and a real clear
    /// (`dryRun: false`, `deleted`). The fields of the other answer are nil.
    public struct AgentHistoryClearResult: Codable, Equatable, Sendable {
        public let dryRun: Bool
        public let scope: AgentHistoryClearScope
        public let beforeDays: Int?
        public let wouldDelete: AgentHistoryClearCounts?
        public let deleted: AgentHistoryClearCounts?
        public let total: Int
        public let previewId: String?
        public let expiresAt: String?
    }

    /// POST /kb/agent-history/compact (200).
    public struct AgentHistoryCompactResult: Codable, Equatable, Sendable {
        public let ok: Bool
        public let mode: String     // "incremental" | "full"
        public let pagesFreed: Int
        public let bytesBefore: Int
        public let bytesAfter: Int
        public let ms: Int
    }

    // MARK: - Calls

    func storageReport() async throws -> StorageReport {
        try await get("/kb/storage", authenticated: true)
    }

    /// No retries: a store that is down (503) is reported at once, not after the GET backoff.
    func agentHistorySettings() async throws -> AgentHistorySettings {
        try await send(path: "/kb/agent-history/settings", method: "GET", body: nil as EmptyBody?,
                       authenticated: true, allowRetries: false)
    }

    /// Saves the raw-row retention. The server clamps the value to 7...365 and
    /// answers with the value it kept, so callers show the returned one.
    func setAgentHistoryRetention(days: Int) async throws -> AgentHistorySettings {
        struct Req: Encodable { let retentionDays: Int }
        return try await put("/kb/agent-history/settings", body: Req(retentionDays: days), authenticated: true)
    }

    /// Step one of a clear: counts a real clear would delete, plus the
    /// `previewId` that authorises it (valid five minutes).
    func previewAgentHistoryClear(scope: AgentHistoryClearScope,
                                  beforeDays: Int? = nil) async throws -> AgentHistoryClearResult {
        struct Req: Encodable {
            let scope: String
            let beforeDays: Int?
            let dryRun: Bool
        }
        return try await post("/kb/agent-history/clear",
                              body: Req(scope: scope.rawValue, beforeDays: beforeDays, dryRun: true),
                              authenticated: true, timeout: Self.longCallTimeout)
    }

    /// Step two of a clear. Needs the `previewId` of a dry run for the same
    /// scope and cutoff; the server consumes it whatever the answer.
    func performAgentHistoryClear(scope: AgentHistoryClearScope,
                                  beforeDays: Int? = nil,
                                  previewId: String) async throws -> AgentHistoryClearResult {
        struct Req: Encodable {
            let scope: String
            let beforeDays: Int?
            let dryRun: Bool
            let previewId: String
        }
        return try await post("/kb/agent-history/clear",
                              body: Req(scope: scope.rawValue, beforeDays: beforeDays,
                                        dryRun: false, previewId: previewId),
                              authenticated: true, timeout: Self.longCallTimeout)
    }

    /// Compaction can run for a while (a full VACUUM), so it gets a long idle
    /// timer. A 503 (store down) or 507 (disk short) is a state the user is told
    /// about in the card, not a fault to log as an incident.
    func compactAgentHistory() async throws -> AgentHistoryCompactResult {
        try await send(path: "/kb/agent-history/compact", method: "POST", body: EmptyBody(),
                       authenticated: true, timeout: Self.longCallTimeout,
                       incidentFreeStatuses: [503, 507])
    }
}

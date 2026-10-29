// Seeded from schema/http/fixtures and INVENTORY.md; maintained by hand.
// Each row names a fixture endpoint and the Swift type LlmIdeAPIClient decodes it into.

import Foundation
import LlmIdeMacLib

/// Decodes one 2xx fixture body. Returns the model re-encoded when the type is
/// Encodable (the dropped-key check needs it), nil when it is only Decodable.
struct Route {
    let endpoint: String
    let model: String
    let decode: (Data) throws -> Data?
}

func route<T: Decodable>(_ endpoint: String, _ model: String, _ type: T.Type) -> Route {
    Route(endpoint: endpoint, model: model) { data in
        // Same decoder the client uses: LlmIdeAPIClient.init sets keyDecodingStrategy
        // .useDefaultKeys and leaves the date strategy at its default.
        let value = try JSONDecoder().decode(T.self, from: data)
        if let encodable = value as? any Encodable { return try JSONEncoder().encode(encodable) }
        // A lab mirror of a private wrapper declares its keys, so at least the
        // envelope is drop-checked even though the element models are Decodable-only.
        if let envelope = T.self as? any Envelope.Type {
            return try JSONSerialization.data(withJSONObject: Dictionary(uniqueKeysWithValues: envelope.keys.map { ($0, true) }))
        }
        return nil
    }
}

/// A lab mirror's top-level keys (the stored properties of the client wrapper it mirrors).
protocol Envelope { static var keys: Set<String> { get } }

/// Fixture endpoint -> the Mac model the client decodes it into.
let apiRoutes: [Route] = [
    route("GET /auth/me", "UserInfo", UserInfo.self),  // me
    route("POST /auth/login", "SessionResponse", SessionResponse.self),  // login
    route("POST /auth/refresh", "SessionResponse", SessionResponse.self),  // refresh
    route("POST /auth/register", "[String: UserInfo]", [String: UserInfo].self),  // register
    route("GET /auth/me/plugins", "PluginsListResponse", PluginsListResponse.self),  // listPlugins
    route("POST /auth/me/plugins/reload", "PluginReloadResponse", PluginReloadResponse.self),  // reloadPlugins
    route("DELETE /auth/me/plugins/uninstall/:name", "PluginUninstallResponse", PluginUninstallResponse.self),  // uninstallPlugin
    route("GET /auth/me/claude-plugins/installed", "ClaudePluginsListResponse", ClaudePluginsListResponse.self),  // listClaudeInstalled
    route("GET /auth/me/claude-plugins/marketplace", "ClaudeMarketplaceListResponse", ClaudeMarketplaceListResponse.self),  // listClaudeMarketplace
    route("GET /auth/me/codex-plugins/installed", "CodexPluginsListResponse", CodexPluginsListResponse.self),  // listCodexInstalled
    route("GET /auth/me/codex-plugins/marketplace", "CodexMarketplaceListResponse", CodexMarketplaceListResponse.self),  // listCodexMarketplace
    route("POST /auth/me/claude-plugins/refresh", "PluginRefreshResponse", PluginRefreshResponse.self),  // refreshClaudeSources
    route("POST /auth/me/codex-plugins/refresh", "PluginRefreshResponse", PluginRefreshResponse.self),  // refreshCodexSources
    route("GET /auth/me/claude-plugins/updates", "PluginUpdateCheck", PluginUpdateCheck.self),  // claudePluginUpdates
    route("GET /auth/me/codex-plugins/updates", "PluginUpdateCheck", PluginUpdateCheck.self),  // codexPluginUpdateCheck
    route("GET /auth/me/connectors", "ConnectorListWrap", ConnectorListWrap.self),  // listConnectors
    route("GET /auth/me/connectors/catalog", "ConnectorCatalogWrap", ConnectorCatalogWrap.self),  // fetchConnectorCatalog
    route("GET /auth/me/llm-sources", "LlmSourcesWrap", LlmSourcesWrap.self),  // listLlmSources
    route("GET /auth/me/llm-sources/:id/discovery", "LlmSourceDiscoveryDetail", LlmIdeAPIClient.LlmSourceDiscoveryDetail.self),  // llmSourceDiscovery
    route("GET /auth/me/mcp-plugins", "McpPluginsWrap", McpPluginsWrap.self),  // listMcpPlugins
    route("GET /auth/me/mcp-plugins/catalog", "McpCatalogWrap", McpCatalogWrap.self),  // fetchMcpCatalog
    route("GET /auth/me/mcp-plugins/claude-sources", "ClaudeMcpSourcesWrap", ClaudeMcpSourcesWrap.self),  // scanClaudeMcpSources
    route("GET /auth/me/mcp-plugins/codex-sources", "CodexMcpSourcesWrap", CodexMcpSourcesWrap.self),  // scanCodexMcpSources
    route("GET /auth/me/mcp-plugins/updates", "McpUpdateCheck", LlmIdeAPIClient.McpUpdateCheck.self),  // mcpUpdates
    route("POST /auth/me/mcp-plugins/:id/update", "McpUpdateAck", LlmIdeAPIClient.McpUpdateAck.self),  // updateMcpPlugin
    route("POST /kb/complete", "CompleteResponse", LlmIdeAPIClient.CompleteResponse.self),  // complete
    route("GET /auth/google/status", "GoogleStatusResult", LlmIdeAPIClient.GoogleStatusResult.self),  // googleSignInStatus
    route("POST /auth/google/start", "GoogleStartResult", LlmIdeAPIClient.GoogleStartResult.self),  // googleSignInStart
    route("POST /auth/slack/start", "SlackConnectStartResult", LlmIdeAPIClient.SlackConnectStartResult.self),  // slackConnectStart
    route("GET /auth/slack/status", "SlackConnectStatusResult", LlmIdeAPIClient.SlackConnectStatusResult.self),  // slackConnectStatus
    route("POST /kb/connect-git", "ConnectGitResult", LlmIdeAPIClient.ConnectGitResult.self),  // connectGit
    route("GET /kb/agent-sdk", "AgentSdkStatus", AgentSdkStatus.self),  // agentSdkStatus
    route("POST /kb/agent-sdk/update", "AgentSdkUpdateResult", AgentSdkUpdateResult.self),  // updateAgentSdk
    route("GET /kb/agent/catalog", "AgentSkillCatalog", LlmIdeAPIClient.AgentSkillCatalog.self),  // listAgentSkillCatalog
    route("GET /kb/agent/skill-library", "SkillLibraryWrap", SkillLibraryWrap.self),  // skillLibrary
    route("GET /kb/agent/generation-library", "GenerationLibrary", LlmIdeAPIClient.GenerationLibrary.self),  // generationLibrary
    route("POST /kb/projects/register", "DocProjectRegistration", LlmIdeAPIClient.DocProjectRegistration.self),  // registerProject
    route("GET /kb/docs/templates", "DocTemplatesPage", LlmIdeAPIClient.DocTemplatesPage.self),  // listDocTemplates
    route("GET /kb/docs/commands", "DocCommandsPage", LlmIdeAPIClient.DocCommandsPage.self),  // listDocCommands
    route("PUT /kb/docs/templates/:folder", "DocTemplateSaved", LlmIdeAPIClient.DocTemplateSaved.self),  // saveDocTemplate
    route("DELETE /kb/docs/templates/:folder", "DocDeleteResult", LlmIdeAPIClient.DocDeleteResult.self),  // deleteDocTemplate
    route("PUT /kb/docs/commands/:folder", "DocCommandSaved", LlmIdeAPIClient.DocCommandSaved.self),  // saveDocCommand
    route("DELETE /kb/docs/commands/:folder", "DocDeleteResult", LlmIdeAPIClient.DocDeleteResult.self),  // deleteDocCommand
    route("POST /kb/docs/seed", "DocSeedResult", LlmIdeAPIClient.DocSeedResult.self),  // seedDocFiles
    route("GET /kb/agent/runs", "RunsWrap", RunsWrap.self),  // listAgentRuns
    route("POST /kb/agent/dispatch", "AgentDispatchResponse", LlmIdeAPIClient.AgentDispatchResponse.self),  // dispatchAgent
    route("POST /kb/agent/stop", "AgentStopResponse", LlmIdeAPIClient.AgentStopResponse.self),  // stopAgent
    route("GET /kb/agent/persona", "AgentPersonaWrap", LlmIdeAPIClient.AgentPersonaWrap.self),  // getAgentPersona
    route("GET /kb/agent/tool-approvals", "ToolPermissions", LlmIdeAPIClient.ToolPermissions.self),  // toolPermissions
    route("GET /kb/meeting/:id", "MeetingDetail", LlmIdeAPIClient.MeetingDetail.self),  // getMeeting
    route("GET /kb/search", "SearchWrap", SearchWrap.self),  // search
    route("GET /kb/live/sessions", "LiveSessionsWrap", LiveSessionsWrap.self),  // listLiveSessions
    route("GET /kb/live/:id", "LiveCaptionsResponse", LlmIdeAPIClient.LiveCaptionsResponse.self),  // liveCaptions
    route("GET /kb/usage/limits", "UsageLimits", LlmIdeAPIClient.UsageLimits.self),  // usageLimits
    route("PUT /kb/usage/limits", "SaveLimitsWrap", SaveLimitsWrap.self),  // saveUsageLimits
    route("POST /kb/providers/verify", "ProviderVerifyResult", LlmIdeAPIClient.ProviderVerifyResult.self),  // verifyProvider
    route("POST /kb/providers/models", "ProviderModelsWrap", ProviderModelsWrap.self),  // listProviderModels
    route("POST /kb/outcomes/refresh", "OutcomeRefreshSummary", LlmIdeAPIClient.OutcomeRefreshSummary.self),  // refreshOutcomes
    route("GET /kb/project/:id/export", "ProjectExportBundle", ProjectExportBundle.self),  // exportProject
    route("POST /kb/ingest", "[String: AnyCodable]", [String: AnyCodable].self),  // ingestMeeting
    route("GET /kb/storage", "StorageReport", LlmIdeAPIClient.StorageReport.self),  // storageReport
    route("GET /kb/agent-history/settings", "AgentHistorySettings", LlmIdeAPIClient.AgentHistorySettings.self),  // agentHistorySettings
    route("PUT /kb/agent-history/settings", "AgentHistorySettings", LlmIdeAPIClient.AgentHistorySettings.self),  // setAgentHistoryRetention
    route("POST /kb/agent-history/clear", "AgentHistoryClearResult", LlmIdeAPIClient.AgentHistoryClearResult.self),  // previewAgentHistoryClear, performAgentHistoryClear
    route("POST /kb/agent-history/compact", "AgentHistoryCompactResult", LlmIdeAPIClient.AgentHistoryCompactResult.self),  // compactAgentHistory
    route("POST /kb/index/notes", "IndexUpsertResult", LlmIdeAPIClient.IndexUpsertResult.self),  // indexUpsertNotes
    route("POST /kb/index/reconcile", "IndexReconcileResult", LlmIdeAPIClient.IndexReconcileResult.self),  // indexReconcile
    route("DELETE /kb/index/notes/:key", "IndexDeleteResult", LlmIdeAPIClient.IndexDeleteResult.self),  // indexDeleteNote
    route("GET /kb/index/status", "IndexStatusResult", LlmIdeAPIClient.IndexStatusResult.self),  // indexStatus
    route("POST /kb/index/scan", "IndexScanResult", LlmIdeAPIClient.IndexScanResult.self),  // indexScan
]

/// 2xx fixture endpoints this table does not decode, with the reason.
let apiSkipped: [(endpoint: String, reason: String)] = [
    ("GET /kb/agent/working-state", "Mac client calls this path (ChatLifecycle); the decode is a private wrapper, ack or tuple, not in this table yet"),
    ("GET /kb/live/:id/status", "no Mac caller (extension-facing live-capture route; the Mac archive does not call it)"),
    ("GET /kb/live/unacked", "no Mac caller (extension-facing live-capture route; the Mac archive does not call it)"),
    ("POST /agent/v2/sessions/purge", "Mac client calls this path (ChatLifecycle); the decode is a private wrapper, ack or tuple, not in this table yet"),
    ("POST /kb/archive-receipts", "Mac client calls this path (ChatLifecycle); the decode is a private wrapper, ack or tuple, not in this table yet"),
    ("POST /kb/chat/sessions/:id/archive/begin", "Mac client calls this path (ChatLifecycle); the decode is a private wrapper, ack or tuple, not in this table yet"),
    ("POST /kb/chat/sessions/:id/archive/commit", "Mac client calls this path (ChatLifecycle); the decode is a private wrapper, ack or tuple, not in this table yet"),
    ("POST /kb/live/:id/ack", "no Mac caller (extension-facing live-capture route; the Mac archive does not call it)"),
    ("POST /kb/session-purges", "Mac client calls this path (ChatLifecycle); the decode is a private wrapper, ack or tuple, not in this table yet"),
    ("POST /kb/summarize", "Mac decodes a private SummarizeResp, then builds MeetingSummary itself; not in this table yet"),
    ("DELETE /agent/v2/session", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("DELETE /auth/me/connectors/:id", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("DELETE /auth/me/mcp-plugins/:id", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("DELETE /kb/agent/ask/history", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/os/state", "no Mac caller yet (os-kit OS-3)"),
    ("GET /kb/os/stream", "server-sent event stream; consumed by the System web view (os-kit OS-3)"),
    ("DELETE /kb/agent/personas/:id", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("DELETE /kb/agent/project-memory", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("DELETE /kb/agent/session-memory", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("DELETE /kb/agent/tool-approvals", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("DELETE /kb/chat/sessions/:id", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("DELETE /kb/chat/sessions/:id/messages", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("DELETE /kb/delete", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("DELETE /kb/issue-schedule", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("DELETE /kb/plan/delete", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("DELETE /kb/review/delete", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /auth/google/callback", "OAuth browser callback page, not a JSON API body"),
    ("GET /auth/mcp-connector/callback", "OAuth browser callback page, not a JSON API body"),
    ("GET /auth/mcp-connector/status", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /auth/me/audit", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /auth/me/llm-sources/updates", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("GET /auth/me/prefs", "Mac decodes the private UserPrefsWrap ({prefs: ...}); not in this table yet"),
    ("GET /auth/me/secrets", "Mac decodes a private Resp; not in this table yet"),
    ("GET /auth/slack/callback", "OAuth browser callback page, not a JSON API body"),
    ("GET /auth/well-known", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("GET /health", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("GET /kb/activity", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("GET /kb/agent/ask/history", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/agent/feedback/by-task", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/agent/feedback/stats", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/agent/personas", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/agent/project-memory", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("GET /kb/agent/session-memory", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("GET /kb/chat/sessions", "Mac client calls this path (ChatLifecycle); the decode is a private wrapper, ack or tuple, not in this table yet"),
    ("GET /kb/chat/sessions/:id", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/entity/:id", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/export-all", "newline-delimited LegacyExportRecord stream; not decoded as one JSON body"),
    ("GET /kb/issue-schedule", "Mac decodes a dictionary keyed by Int, the response shape is not pinned here yet"),
    ("GET /kb/issues", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/outcomes/stats", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/outcomes/task/:id", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/plan/:id", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/plans", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/review/get/:id", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/review/list", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/routing-tiers", "Mac decodes a private wrapper and returns a tuple; not in this table yet"),
    ("GET /kb/stats", "Mac decodes a private LegacyStatsBody; not in this table yet"),
    ("GET /kb/system/status", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("GET /kb/usage/ratelimits", "Mac decodes a private Resp wrapper around RateLimits; not in this table yet"),
    ("GET /kb/usage/resolve", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("GET /kb/usage/summary", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("GET /kb/usage/turn-composition", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("PATCH /kb/chat/sessions/:id", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("PATCH /kb/plan-task/update", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /agent/v2/cancel", "Mac method returns Bool from a private ack; no model type to decode"),
    ("POST /agent/v2/decision", "Mac method returns Bool from a private ack; no model type to decode"),
    ("POST /agent/v2/stream", "server-sent event stream; events are decoded per variant by the chat transport, not by this table"),
    ("POST /auth/logout", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /auth/me/connectors/add", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /auth/me/delete", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /auth/me/llm-sources/items", "Mac decodes a private wrapper and returns [String]; not in this table yet"),
    ("POST /auth/me/llm-sources/toggle", "Mac method returns Bool from a private ack; no model type to decode"),
    ("POST /auth/me/mcp-plugins/add", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /auth/me/mcp-plugins/consent", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /auth/me/mcp-plugins/toggle", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /auth/me/password", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /auth/me/repos", "Mac decodes a private Resp and returns a String; not in this table yet"),
    ("POST /auth/me/secrets", "Mac decodes a private Resp; not in this table yet"),
    ("POST /auth/reset-confirm", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /auth/reset-request", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /chat", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /code-assist", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /code-assist/decision", "Mac method returns Bool from a private ack; no model type to decode"),
    ("POST /extract-entities", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /generate-doc", "Mac decodes GeneratedDoc through a private wire struct; not in this table yet"),
    ("POST /generate-docx", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /generate-notes", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /generate-questions", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/activity", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /kb/activity/seen", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /kb/agent/ask", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/agent/feedback", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/agent/personas", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/analyze-risks", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/chat/sessions", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/chat/sessions/:id/messages", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/code-sync", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/conflict-questions", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/connect-qa", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/connect-tickets-json", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/custom-providers", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /kb/delete", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/dispatch", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/email/seen", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /kb/generate-code", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/generate-plan", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/ingest-code-graph", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /kb/live/:id/append", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/live/:id/finalize", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/loop/agent-run", "LoopAgentResult is not Decodable; the Mac decodes a private wire struct"),
    ("POST /kb/mcp-connector/seen", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /kb/outcomes/retry-failed", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/plan-task/update", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/plan/delete", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/plan/save", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/review/approve", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/review/delete", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/review/reject", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/review/submit", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("POST /kb/routing-tiers", "Mac decodes a private Ack wrapper around TierRoutingDropped; not in this table yet"),
    ("POST /kb/slack/seen", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("POST /kb/usage/record", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
    ("PUT /auth/me/prefs", "Mac decodes the private UserPrefsWrap ({prefs: ...}); not in this table yet"),
    ("PUT /kb/agent/persona", "no Mac caller (only GET /kb/agent/persona is called)"),
    ("PUT /kb/agent/personas/:id", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("PUT /kb/agent/personas/active", "no Mac caller (see schema/http/INVENTORY.md)"),
    ("PUT /kb/issue-schedule", "Mac client calls this path but the decode is a private wrapper, ack or tuple; not in this table yet"),
]

// Lab mirrors of the client's PRIVATE response wrappers (each names the
// wrapper it mirrors). The element types are the client's real models; only
// the one-key envelope is restated here, because a private type cannot be
// named from another target. Keep in sync with the client file named.

/// LlmIdeAPIClient+Agent.swift listAgentRuns: struct Wrap { runs }
struct RunsWrap: Decodable, Envelope { let runs: [LlmIdeAPIClient.AgentRun] ; static let keys: Set<String> = ["runs"] }
/// LlmIdeAPIClient+AgentMeta.swift SkillLibraryResponse
struct SkillLibraryWrap: Decodable, Envelope { let repo: String?; let skills: [LlmIdeAPIClient.SkillLibraryEntry] ; static let keys: Set<String> = ["repo", "skills"] }
/// LlmIdeAPIClient+Connectors.swift ConnectorListResponse / ConnectorCatalogResponse
struct ConnectorListWrap: Decodable, Envelope { let connectors: [ConnectorCatalogEntry] ; static let keys: Set<String> = ["connectors"] }
struct ConnectorCatalogWrap: Decodable, Envelope { let catalog: [ConnectorCatalogEntry] ; static let keys: Set<String> = ["catalog"] }
/// LlmIdeAPIClient+LlmSources.swift LlmSourcesListResponse
struct LlmSourcesWrap: Decodable, Envelope { let sources: [LlmIdeAPIClient.LlmSourceInfo] ; static let keys: Set<String> = ["sources"] }
/// LlmIdeAPIClient+McpPlugins.swift McpPluginListResponse / McpCatalogResponse / *McpSourcesResponse
struct McpPluginsWrap: Decodable, Envelope { let plugins: [LlmIdeAPIClient.McpPluginInfo] ; static let keys: Set<String> = ["plugins"] }
struct McpCatalogWrap: Decodable, Envelope { let servers: [LlmIdeAPIClient.McpCatalogEntry] ; static let keys: Set<String> = ["servers"] }
struct ClaudeMcpSourcesWrap: Decodable, Envelope { let servers: [LlmIdeAPIClient.ClaudeMcpSource] ; static let keys: Set<String> = ["servers"] }
struct CodexMcpSourcesWrap: Decodable, Envelope { let servers: [LlmIdeAPIClient.CodexMcpSource] ; static let keys: Set<String> = ["servers"] }
/// LlmIdeAPIClient+KB.swift search: struct Wrap { results }
struct SearchWrap: Decodable, Envelope { let results: [LlmIdeAPIClient.SearchHit] ; static let keys: Set<String> = ["results"] }
/// LlmIdeAPIClient+Live.swift listLiveSessions: struct Wrap { sessions }
struct LiveSessionsWrap: Decodable, Envelope { let sessions: [LlmIdeAPIClient.LiveSessionInfo] ; static let keys: Set<String> = ["sessions"] }
/// LlmIdeAPIClient+Providers.swift listProviderModels: struct Resp { models, entries? }
struct ProviderModelsWrap: Decodable, Envelope { let models: [String]; let entries: [ProviderModelEntry]? ; static let keys: Set<String> = ["models", "entries"] }
/// LlmIdeAPIClient+Usage.swift saveUsageLimits: struct Resp { ok, chains }
struct SaveLimitsWrap: Codable { let ok: Bool; let chains: [String: [LlmIdeAPIClient.ModelLimit]] }

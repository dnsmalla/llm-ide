import Foundation

extension LlmIdeAPIClient {

    struct AgentDispatchRequest: Encodable {
        let sessionId: String?
        let planId: String?
        let language: String?       // ISO code; nil = server defaults to 'en'
        let meetingUrl: String?     // when set + bot-worker is running,
                                    // server launches a real bot
    }

    struct AgentDispatchResponse: Decodable {
        let sessionId: String
        let planId: String?
        let attached: Bool
        let reason: String?
        // Bot fields — optional so the response stays
        // backwards-compatible with the co-pilot-only path.
        let botId: String?
        let botInRoom: Bool?
        let bootError: String?
    }

    struct AgentStopRequest: Encodable {
        let sessionId: String
    }

    struct AgentStopResponse: Decodable {
        let stopped: Bool
        let reason: String?
    }

    struct AgentDecision: Decodable, Equatable {
        let reason: String
        let score: Double?
        let asked: Bool?
    }

    struct AgentRun: Decodable, Identifiable {
        let sessionId: String
        let planId: String?
        let startedAt: Double
        let lastTickAt: Double?
        let lastDecision: AgentDecision?
        var id: String { sessionId }
    }

    /// Active persona fields that shape conversational LLM surfaces
    /// (/chat, /code-assist, /kb/agent/ask, the in-meeting agent loop).
    struct AgentPersona: Codable, Equatable {
        let name: String?
        let promptSuffix: String?
        /// Whether to dispatch the meeting agent automatically when
        /// capture starts. Server defaults to false; older blobs that
        /// pre-date this field decode as false thanks to the
        /// custom initializer below.
        let autoDispatch: Bool

        init(name: String?, promptSuffix: String?, autoDispatch: Bool = false) {
            self.name = name
            self.promptSuffix = promptSuffix
            self.autoDispatch = autoDispatch
        }

        enum CodingKeys: String, CodingKey {
            case name, promptSuffix, autoDispatch
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.name = try c.decodeIfPresent(String.self, forKey: .name)
            self.promptSuffix = try c.decodeIfPresent(String.self, forKey: .promptSuffix)
            self.autoDispatch = (try? c.decodeIfPresent(Bool.self, forKey: .autoDispatch)) ?? false
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(name, forKey: .name)
            try c.encodeIfPresent(promptSuffix, forKey: .promptSuffix)
            try c.encode(autoDispatch, forKey: .autoDispatch)
        }
    }
    struct AgentPersonaWrap: Codable { let persona: AgentPersona? }

    // --- Agent methods -----------------------------------------------

    /// Attach the server-side question loop to one of the user's
    /// active live capture sessions.  Pass nil to let the server
    /// pick the most recent.  No bot, no third-party transport —
    /// the agent just reads and writes to /kb/live/<sessionId>.
    func dispatchAgent(sessionId: String? = nil, planId: String? = nil,
                       language: String? = nil, meetingUrl: String? = nil) async throws -> AgentDispatchResponse {
        try await post("/kb/agent/dispatch",
                       body: AgentDispatchRequest(sessionId: sessionId, planId: planId,
                                                  language: language, meetingUrl: meetingUrl),
                       authenticated: true)
    }

    func stopAgent(sessionId: String) async throws -> AgentStopResponse {
        try await post("/kb/agent/stop",
                       body: AgentStopRequest(sessionId: sessionId),
                       authenticated: true)
    }

    func listAgentRuns() async throws -> [AgentRun] {
        struct Wrap: Decodable { let runs: [AgentRun] }
        let r: Wrap = try await get("/kb/agent/runs", authenticated: true)
        return r.runs
    }

    func getAgentPersona() async throws -> AgentPersona? {
        let r: AgentPersonaWrap = try await get("/kb/agent/persona", authenticated: true)
        return r.persona
    }

    // `AgentAskMessage`/`AgentAskHistoryItem`, `listAgentAskHistory`,
    // `clearAgentAskHistory`, and `askAgent` (the `/kb/agent/ask` +
    // `/kb/agent/ask/history` trio) were removed here in Task 8: their last
    // caller, `MobileControlManager`'s `llmide_chat`/history/clear arms,
    // moved onto the shared `.quick` `ChatEngine` (`ChatEngineRegistry`) —
    // see the note after `fetch(_:path:)` in `LlmIdeAPIClient.swift` for the
    // full history of this migration.

    // MARK: - Skill catalog ──────────────────────────────────────────────

    /// One skill entry from the server catalog.
    struct SkillEntry: Decodable, Identifiable, Equatable {
        let name: String
        let kind: String        // "read" | "write"
        let description: String
        var id: String { name }
    }

    /// Plugin skills group — a plugin can contribute multiple skills.
    struct PluginSkillGroup: Decodable {
        let pluginName: String
        let pluginDisplayName: String
        let skills: [SkillEntry]
    }

    /// Skills catalog broken down by source.
    struct SkillsCatalog: Decodable {
        let global: [SkillEntry]    // global tools (ask-internal, update-file…)
        let `internal`: [SkillEntry] // KB skills (search-kb, create-gitlab-issue…)
        let plugins: [PluginSkillGroup]
    }

    /// Plugin subagent descriptor.
    struct SubagentEntry: Decodable, Equatable {
        let name: String
        let description: String
        let allowedTools: [String]?
    }

    /// Plugin subagents group — parallels PluginSkillGroup.
    struct PluginSubagentGroup: Decodable {
        let pluginName: String
        let pluginDisplayName: String
        let subagents: [SubagentEntry]
    }

    /// Combined catalog: executable skills + plugin subagents — used by
    /// the Code Assistant "/" autocomplete (CompletionController).
    struct AgentSkillCatalog: Decodable {
        let skills: SkillsCatalog
        let subagents: SubagentsCatalog

        struct SubagentsCatalog: Decodable {
            let plugins: [PluginSubagentGroup]
        }
    }

    /// Fetch skills + plugin subagents for the chat "/" menu.
    /// Failures are swallowed by the caller (empty autocomplete).
    func listAgentSkillCatalog() async throws -> AgentSkillCatalog {
        try await get("/kb/agent/catalog", authenticated: true)
    }
}

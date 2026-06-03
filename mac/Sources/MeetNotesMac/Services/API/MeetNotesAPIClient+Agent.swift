import Foundation

extension MeetNotesAPIClient {

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

    /// One row in the user's persona registry. The active persona's
    /// fields shape every conversational LLM surface — /chat,
    /// /code-assist, /kb/agent/ask, the in-meeting agent loop.
    struct AgentPersonaRow: Codable, Equatable, Identifiable {
        let id: String
        let name: String?
        let promptSuffix: String?
        let autoDispatch: Bool
        let createdAt: Double

        enum CodingKeys: String, CodingKey {
            case id, name, promptSuffix, autoDispatch, createdAt
        }
        init(id: String, name: String?, promptSuffix: String?, autoDispatch: Bool, createdAt: Double) {
            self.id = id; self.name = name; self.promptSuffix = promptSuffix
            self.autoDispatch = autoDispatch; self.createdAt = createdAt
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = try c.decode(String.self, forKey: .id)
            self.name = try c.decodeIfPresent(String.self, forKey: .name)
            self.promptSuffix = try c.decodeIfPresent(String.self, forKey: .promptSuffix)
            self.autoDispatch = (try? c.decodeIfPresent(Bool.self, forKey: .autoDispatch)) ?? false
            self.createdAt = (try? c.decodeIfPresent(Double.self, forKey: .createdAt)) ?? 0
        }
    }

    struct AgentPersonaList: Decodable {
        let personas: [AgentPersonaRow]
        let active: String?
    }

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
    }
    struct AgentPersonaWrap: Codable { let persona: AgentPersona? }

    struct AgentFeedbackByVerdict: Decodable, Equatable {
        let useful: Int
        let noise: Int
        let later: Int
    }
    struct AgentFeedbackAvgScore: Decodable, Equatable {
        let useful: Double?
        let noise: Double?
        let later: Double?
    }
    struct AgentFeedbackStats: Decodable, Equatable {
        let total: Int
        let byVerdict: AgentFeedbackByVerdict
        let usefulRate: Double?
        let avgScore: AgentFeedbackAvgScore
        let sinceDays: Int
    }

    /// Per-plan-task useful-rate breakdown.  Drives the per-task
    /// chip on PlanView.  Only tasks with at least one feedback
    /// entry come back.
    struct AgentFeedbackByTaskItem: Decodable, Equatable, Identifiable {
        let planTaskId: String
        let total: Int
        let byVerdict: AgentFeedbackByVerdict
        let usefulRate: Double?
        let avgScoreUseful: Double?
        let avgScoreNoise: Double?
        var id: String { planTaskId }
    }

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

    struct AgentAskMessage: Codable, Equatable, Identifiable {
        enum Role: String, Codable { case user, assistant }
        let id: UUID
        let role: Role
        let content: String
        init(id: UUID = UUID(), role: Role, content: String) {
            self.id = id; self.role = role; self.content = content
        }
        // Server doesn't care about the local UUID; we drop it when wiring.
    }

    /// Stored history of the Ask-the-Agent transcript. Each row has
    /// a stable per-user `seq` (oldest first), the role, and the
    /// message text. Wire shape matches what `appendAgentAskMessage`
    /// writes server-side.
    struct AgentAskHistoryItem: Decodable, Identifiable {
        let seq: Int
        let role: String
        let content: String
        let createdAt: Double
        var id: Int { seq }

        enum CodingKeys: String, CodingKey {
            case seq, role, content
            case createdAt = "created_at"
        }
    }

    /// Fetch the most recent N persisted Ask-the-Agent turns,
    /// oldest-first within the page. The sheet uses this on open
    /// to restore the prior conversation.
    func listAgentAskHistory(limit: Int = 50) async throws -> [AgentAskHistoryItem] {
        struct Resp: Decodable { let messages: [AgentAskHistoryItem] }
        let r: Resp = try await get("/kb/agent/ask/history?limit=\(limit)", authenticated: true)
        return r.messages
    }

    /// Wipe the user's Ask-the-Agent transcript server-side. Returns
    /// the number of rows removed for the optimistic UI line.
    @discardableResult
    func clearAgentAskHistory() async throws -> Int {
        struct Resp: Decodable { let removed: Int }
        let r: Resp = try await delete("/kb/agent/ask/history", authenticated: true)
        return r.removed
    }

    /// Free-text Q&A with the meeting agent. Persona (name +
    /// voice/focus suffix) is applied server-side so the answer
    /// matches the in-meeting voice. History is the prior turns of
    /// this conversation, capped to the last 10 server-side; pass
    /// whatever the UI has accumulated.
    func askAgent(message: String, history: [AgentAskMessage] = []) async throws -> String {
        struct WireMsg: Encodable { let role: String; let content: String }
        struct Req: Encodable { let message: String; let history: [WireMsg] }
        struct Resp: Decodable { let reply: String }
        let wire = history.map { WireMsg(role: $0.role.rawValue, content: $0.content) }
        let r: Resp = try await post("/kb/agent/ask",
                                     body: Req(message: message, history: wire),
                                     authenticated: true)
        return r.reply
    }

    // Multi-persona surface ─────────────────────────────────────

    func listAgentPersonas() async throws -> AgentPersonaList {
        try await get("/kb/agent/personas", authenticated: true)
    }

    func createAgentPersona(name: String, promptSuffix: String, autoDispatch: Bool) async throws -> AgentPersonaList {
        struct Req: Encodable { let name: String; let promptSuffix: String; let autoDispatch: Bool }
        struct Resp: Decodable {
            let persona: AgentPersonaRow
            let personas: [AgentPersonaRow]
            let active: String?
        }
        let r: Resp = try await post(
            "/kb/agent/personas",
            body: Req(name: name, promptSuffix: promptSuffix, autoDispatch: autoDispatch),
            authenticated: true,
        )
        return AgentPersonaList(personas: r.personas, active: r.active)
    }

    func updateAgentPersona(id: String, name: String, promptSuffix: String, autoDispatch: Bool) async throws -> AgentPersonaRow {
        struct Req: Encodable { let name: String; let promptSuffix: String; let autoDispatch: Bool }
        struct Resp: Decodable { let persona: AgentPersonaRow }
        let r: Resp = try await send(
            path: "/kb/agent/personas/\(percentEncoded(id))",
            method: "PUT",
            body: Req(name: name, promptSuffix: promptSuffix, autoDispatch: autoDispatch),
            authenticated: true,
        )
        return r.persona
    }

    @discardableResult
    func deleteAgentPersona(id: String) async throws -> Bool {
        struct Resp: Decodable { let removed: Bool }
        let r: Resp = try await delete("/kb/agent/personas/\(percentEncoded(id))", authenticated: true)
        return r.removed
    }

    func setActiveAgentPersona(id: String) async throws -> AgentPersonaList {
        struct Req: Encodable { let id: String }
        let r: AgentPersonaList = try await send(
            path: "/kb/agent/personas/active",
            method: "PUT",
            body: Req(id: id),
            authenticated: true,
        )
        return r
    }

    func getAgentFeedbackStats(sinceDays: Int = 30) async throws -> AgentFeedbackStats {
        try await get("/kb/agent/feedback/stats?sinceDays=\(sinceDays)", authenticated: true)
    }

    func getAgentFeedbackByTask(sinceDays: Int = 30) async throws -> [AgentFeedbackByTaskItem] {
        struct Wrap: Decodable { let tasks: [AgentFeedbackByTaskItem] }
        let r: Wrap = try await get("/kb/agent/feedback/by-task?sinceDays=\(sinceDays)",
                                    authenticated: true)
        return r.tasks
    }

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

    /// Combined catalog: skills + subagents — loaded once for the Library.
    struct AgentSkillCatalog: Decodable {
        let skills: SkillsCatalog
        let subagents: SubagentsCatalog

        struct SubagentsCatalog: Decodable {
            let plugins: [PluginSubagentGroup]
        }
    }

    /// Fetch the full Library catalog (skills + subagents).
    /// Called once on Library appear; fails gracefully — caller shows
    /// empty sections rather than surfacing a hard error.
    func listAgentSkillCatalog() async throws -> AgentSkillCatalog {
        try await get("/kb/agent/catalog", authenticated: true)
    }
}

import Foundation

// LLM-source registry — GET/POST/DELETE /auth/me/llm-sources/*.
// Mirrors extension/llm-sources/registry.mjs. Each registered source may
// contribute any mix of four discoverable kinds: skills (chat "/" menu
// discovery via /kb/agent/skill-library), agents (subagent definitions),
// hooks, and MCP servers. Discovery-only for ALL FOUR — a source never
// contributes agent-loadable tools, and agents/hooks/MCP servers are
// catalogued for display only, never invoked/executed/spawned.
extension LlmIdeAPIClient {

    struct LlmSourceInfo: Decodable, Identifiable, Equatable {
        let id: String
        let name: String
        let origin: String       // "builtin" | "git" | "local" (server may add more later)
        let location: String?    // absolute path (in-place read) — nil if never resolved
        let builtin: Bool
        let version: String?
        let ref: String?
        let installed: Bool
        let skillCount: Int
        let agentCount: Int
        let hookCount: Int
        let mcpCount: Int
        let enabled: Bool

        enum CodingKeys: String, CodingKey {
            case id, name, origin, location, builtin, version, ref, installed
            case skillCount, agentCount, hookCount, mcpCount, enabled
        }
        /// `agentCount`/`hookCount`/`mcpCount` arrived with the v28 MCP bump
        /// (v27 renamed the endpoints but didn't carry them). Decode all four
        /// counts with fallbacks so an app paired with a not-yet-restarted v27
        /// server still decodes the list instead of throwing `keyNotFound` and
        /// silently rendering the section empty. Mirrors the back-compat pattern
        /// in `SkillLibraryEntry.init(from:)`.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id         = try c.decode(String.self, forKey: .id)
            self.name       = try c.decode(String.self, forKey: .name)
            self.origin     = try c.decode(String.self, forKey: .origin)
            self.location   = try c.decodeIfPresent(String.self, forKey: .location)
            self.builtin    = try c.decode(Bool.self, forKey: .builtin)
            self.version    = try c.decodeIfPresent(String.self, forKey: .version)
            self.ref        = try c.decodeIfPresent(String.self, forKey: .ref)
            self.installed  = try c.decode(Bool.self, forKey: .installed)
            self.skillCount = try c.decodeIfPresent(Int.self, forKey: .skillCount) ?? 0
            self.agentCount = try c.decodeIfPresent(Int.self, forKey: .agentCount) ?? 0
            self.hookCount  = try c.decodeIfPresent(Int.self, forKey: .hookCount) ?? 0
            self.mcpCount   = try c.decodeIfPresent(Int.self, forKey: .mcpCount) ?? 0
            self.enabled    = try c.decode(Bool.self, forKey: .enabled)
        }
    }
    private struct LlmSourcesListResponse: Decodable { let sources: [LlmSourceInfo] }

    struct LlmSourceSummary: Decodable {
        let id: String
        let name: String
        let origin: String
        let location: String?
        let builtin: Bool
        let version: String?
        let ref: String?
    }
    private struct AddLlmSourceResponse: Decodable { let source: LlmSourceSummary }

    /// One catalogued skill, agent (subagent definition), hook, or MCP server
    /// found in a source. Display-only — never invoked/executed/spawned from
    /// the Mac client either.
    struct LlmSourceSkill: Decodable, Identifiable, Equatable {
        let name: String
        let description: String
        let path: String
        var id: String { path }
    }
    struct LlmSourceAgent: Decodable, Identifiable, Equatable {
        let name: String
        let description: String
        let path: String
        var id: String { path }
    }
    struct LlmSourceHook: Decodable, Identifiable, Equatable {
        let event: String
        let matcher: String?
        let command: String
        var id: String { "\(event)|\(matcher ?? "")|\(command)" }
    }
    struct LlmSourceMcpServer: Decodable, Identifiable, Equatable {
        let name: String
        let command: String
        let args: [String]
        var id: String { name }
    }
    struct LlmSourceDiscoveryDetail: Decodable {
        /// Optional so a Mac build ahead of its server still decodes the
        /// pre-skills response shape (the field shipped later than the rest).
        let skills: [LlmSourceSkill]?
        let agents: [LlmSourceAgent]
        let hooks: [LlmSourceHook]
        let mcpServers: [LlmSourceMcpServer]
    }

    private struct ToggleAck: Decodable { let ok: Bool; let enabled: Bool }
    private struct UpdateAck: Decodable { let ok: Bool; let installed: Bool? }
    private struct RemoveAck: Decodable { let ok: Bool }
    struct RefreshDefaultSourcesResult: Decodable {
        let ok: Bool
        let dir: String
        let counts: [String: Int]
        /// true when the refresh found ZERO enabled input sources and kept
        /// the existing folder untouched instead of wiping it (the server
        /// guard added after a one-click Refresh deleted every committed
        /// skill). nil from servers that predate the guard.
        let noSources: Bool?
    }

    /// The id `default-sources` is registered under — the always-on source
    /// whose location IS the committed llm_default_sources folder. Not a
    /// fetchable/git-backed source: "refreshing" it means regenerating that
    /// folder from whatever's currently enabled (see refreshDefaultSources()).
    static let defaultSourcesId = "default-sources"

    /// All registered LLM sources with this user's per-source enable state.
    /// Callers use `try?` at the call site (matches `listPlugins()`'s callers).
    func listLlmSources() async throws -> [LlmSourceInfo] {
        let resp: LlmSourcesListResponse = try await get("/auth/me/llm-sources", authenticated: true)
        return resp.sources
    }

    @discardableResult
    func toggleLlmSource(id: String, enabled: Bool) async throws -> Bool {
        struct Req: Encodable { let id: String; let enabled: Bool }
        let ack: ToggleAck = try await post("/auth/me/llm-sources/toggle",
                                            body: Req(id: id, enabled: enabled),
                                            authenticated: true)
        return ack.enabled
    }

    /// Register a new source. Exactly one of `url`/`path` must be non-nil —
    /// the server 400s otherwise. Admin-gated server-side (403 surfaces via
    /// `APIError.http`; no client-side pre-check, matching every other
    /// admin-gated call in this codebase).
    func addLlmSource(url: String? = nil, path: String? = nil, ref: String? = nil, name: String? = nil) async throws -> LlmSourceSummary {
        struct Req: Encodable { let url: String?; let path: String?; let ref: String?; let name: String? }
        let resp: AddLlmSourceResponse = try await post("/auth/me/llm-sources/add",
                                                           body: Req(url: url, path: path, ref: ref, name: name),
                                                           authenticated: true)
        return resp.source
    }

    /// Re-sync a source (git: fetch + checkout tracked ref; local: refresh
    /// version; builtin: `git submodule update --init .skills`; the
    /// `default-sources` id specifically: regenerate the llm_default_sources
    /// snapshot from the currently enabled sources — same rebuild as
    /// `refreshDefaultSources()` below, just reached via this admin-gated
    /// route instead). Returns whether the builtin submodule ended up
    /// checked out — irrelevant for non-builtin sources (nil in the
    /// response, defaults false). Admin-gated server-side.
    @discardableResult
    func updateLlmSource(id: String) async throws -> Bool {
        struct Req: Encodable { let id: String }
        let ack: UpdateAck = try await post("/auth/me/llm-sources/update",
                                            body: Req(id: id),
                                            authenticated: true)
        return ack.installed ?? false
    }

    /// On-demand rebuild of the llm_default_sources snapshot for the current
    /// user — skills/agents from enabled sources, hooks catalog, effective
    /// .mcp.json. NOT admin-gated (unlike updateLlmSource) — any user can
    /// refresh their own view of it. Also happens automatically on source
    /// toggle / MCP consent change / server start; this is the explicit
    /// "upgrade now" action for the Library's Default Sources row.
    @discardableResult
    func refreshDefaultSources() async throws -> RefreshDefaultSourcesResult {
        try await post("/auth/me/llm-sources/refresh-default",
                       body: EmptyBody(),
                       authenticated: true)
    }

    /// Remove a registered source (and its clone dir, if any). The server
    /// rejects removing `builtin` with a 400 — surfaced as `APIError.http`.
    func removeLlmSource(id: String) async throws {
        guard let slug = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else { throw APIError.invalidURL }
        let _: RemoveAck = try await delete("/auth/me/llm-sources/\(slug)", authenticated: true)
    }

    /// The agents + hooks + MCP servers a source actually contains — for the
    /// detail view's "what's in here" listing. Empty arrays (not an error)
    /// for a source with zero of a given kind.
    func llmSourceDiscovery(id: String) async throws -> LlmSourceDiscoveryDetail {
        guard let slug = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else { throw APIError.invalidURL }
        return try await get("/auth/me/llm-sources/\(slug)/discovery", authenticated: true)
    }
}

import Foundation

// LLM-source registry — GET/POST/DELETE /auth/me/llm-sources/*.
// Mirrors extension/llm-sources/registry.mjs. Each registered source may
// contribute any mix of four discoverable kinds: skills (chat "/" menu
// discovery via /kb/agent/skill-library), agents (subagent definitions),
// hooks, and MCP servers. Discovery-only for ALL FOUR — a source never
// contributes agent-loadable tools, and agents/hooks/MCP servers are
// catalogued for display only, never invoked/executed/spawned. See
// docs/superpowers/specs/2026-08-11-skills-sources-design.md and
// docs/superpowers/specs/2026-08-12-llm-sources-rename-and-expand.md
// Safety sections.
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

    /// One catalogued agent (subagent definition), hook, or MCP server found
    /// in a source. Display-only — never invoked/executed/spawned from the
    /// Mac client either.
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
        let agents: [LlmSourceAgent]
        let hooks: [LlmSourceHook]
        let mcpServers: [LlmSourceMcpServer]
    }

    private struct ToggleAck: Decodable { let ok: Bool; let enabled: Bool }
    private struct UpdateAck: Decodable { let ok: Bool; let installed: Bool? }
    private struct RemoveAck: Decodable { let ok: Bool }

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
    /// version; builtin: `git submodule update --init .skills`). Returns
    /// whether the builtin submodule ended up checked out — irrelevant
    /// for non-builtin sources (nil in the response, defaults false).
    @discardableResult
    func updateLlmSource(id: String) async throws -> Bool {
        struct Req: Encodable { let id: String }
        let ack: UpdateAck = try await post("/auth/me/llm-sources/update",
                                            body: Req(id: id),
                                            authenticated: true)
        return ack.installed ?? false
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

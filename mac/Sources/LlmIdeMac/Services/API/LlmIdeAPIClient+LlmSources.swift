import Foundation

// LLM-source registry — GET/POST/DELETE /auth/me/llm-sources/*.
// Mirrors extension/llm-sources/registry.mjs. Each registered source may
// contribute any mix of three discoverable kinds: skills (chat "/" menu
// discovery via /kb/agent/skill-library), agents (subagent definitions),
// and hooks. Discovery-only for ALL THREE — a source never contributes
// agent-loadable tools, and agents/hooks are catalogued for display only,
// never invoked/executed. See docs/superpowers/specs/2026-08-11-skills-sources-design.md
// Safety section (superseded in spirit by this rename, same principle).
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

    /// One catalogued agent (subagent definition) or hook found in a source.
    /// Display-only — never invoked/executed from the Mac client either.
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
    struct LlmSourceDiscoveryDetail: Decodable {
        let agents: [LlmSourceAgent]
        let hooks: [LlmSourceHook]
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

    /// The agents + hooks a source actually contains — for the detail view's
    /// "what's in here" listing. Empty arrays (not an error) for a source
    /// with zero of either kind.
    func llmSourceDiscovery(id: String) async throws -> LlmSourceDiscoveryDetail {
        guard let slug = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else { throw APIError.invalidURL }
        return try await get("/auth/me/llm-sources/\(slug)/discovery", authenticated: true)
    }
}

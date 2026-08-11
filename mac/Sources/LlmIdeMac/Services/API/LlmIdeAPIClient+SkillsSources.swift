import Foundation

// Skills-source registry — GET/POST/DELETE /auth/me/skills-sources/*.
// Mirrors extension/skills-sources/registry.mjs. Discovery-only sources:
// each contributes chat "/" menu skills (via /kb/agent/skill-library), never
// agent-loadable tools — see docs/superpowers/specs/2026-08-11-skills-sources-design.md
// Safety section.
extension LlmIdeAPIClient {

    struct SkillsSourceInfo: Decodable, Identifiable, Equatable {
        let id: String
        let name: String
        let origin: String       // "builtin" | "git" | "local" (server may add more later)
        let location: String?    // absolute path (in-place read) — nil if never resolved
        let builtin: Bool
        let version: String?
        let ref: String?
        let installed: Bool
        let skillCount: Int
        let enabled: Bool
    }
    private struct SkillsSourcesListResponse: Decodable { let sources: [SkillsSourceInfo] }

    struct SkillsSourceSummary: Decodable {
        let id: String
        let name: String
        let origin: String
        let location: String?
        let builtin: Bool
        let version: String?
        let ref: String?
    }
    private struct AddSkillsSourceResponse: Decodable { let source: SkillsSourceSummary }

    private struct ToggleAck: Decodable { let ok: Bool; let enabled: Bool }
    private struct UpdateAck: Decodable { let ok: Bool; let installed: Bool? }
    private struct RemoveAck: Decodable { let ok: Bool }

    /// All registered skills sources with this user's per-source enable state.
    /// Callers use `try?` at the call site (matches `listPlugins()`'s callers).
    func listSkillsSources() async throws -> [SkillsSourceInfo] {
        let resp: SkillsSourcesListResponse = try await get("/auth/me/skills-sources", authenticated: true)
        return resp.sources
    }

    @discardableResult
    func toggleSkillsSource(id: String, enabled: Bool) async throws -> Bool {
        struct Req: Encodable { let id: String; let enabled: Bool }
        let ack: ToggleAck = try await post("/auth/me/skills-sources/toggle",
                                            body: Req(id: id, enabled: enabled),
                                            authenticated: true)
        return ack.enabled
    }

    /// Register a new source. Exactly one of `url`/`path` must be non-nil —
    /// the server 400s otherwise. Admin-gated server-side (403 surfaces via
    /// `APIError.http`; no client-side pre-check, matching every other
    /// admin-gated call in this codebase).
    func addSkillsSource(url: String? = nil, path: String? = nil, ref: String? = nil, name: String? = nil) async throws -> SkillsSourceSummary {
        struct Req: Encodable { let url: String?; let path: String?; let ref: String?; let name: String? }
        let resp: AddSkillsSourceResponse = try await post("/auth/me/skills-sources/add",
                                                           body: Req(url: url, path: path, ref: ref, name: name),
                                                           authenticated: true)
        return resp.source
    }

    /// Re-sync a source (git: fetch + checkout tracked ref; local: refresh
    /// version; builtin: `git submodule update --init .skills`). Returns
    /// whether the builtin submodule ended up checked out — irrelevant
    /// for non-builtin sources (nil in the response, defaults false).
    @discardableResult
    func updateSkillsSource(id: String) async throws -> Bool {
        struct Req: Encodable { let id: String }
        let ack: UpdateAck = try await post("/auth/me/skills-sources/update",
                                            body: Req(id: id),
                                            authenticated: true)
        return ack.installed ?? false
    }

    /// Remove a registered source (and its clone dir, if any). The server
    /// rejects removing `builtin` with a 400 — surfaced as `APIError.http`.
    func removeSkillsSource(id: String) async throws {
        guard let slug = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else { throw APIError.invalidURL }
        let _: RemoveAck = try await delete("/auth/me/skills-sources/\(slug)", authenticated: true)
    }
}

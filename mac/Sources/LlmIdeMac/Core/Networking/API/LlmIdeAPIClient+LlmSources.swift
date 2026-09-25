import Foundation

// LLM-source registry — GET/POST/DELETE /auth/me/llm-sources/*.
// Mirrors extension/llm-sources/registry.mjs. Each registered source may
// contribute any mix of six discoverable kinds: skills (chat "/" menu
// discovery via /kb/agent/skill-library), agents (subagent definitions),
// commands (prompt templates), templates (fill-in documents), hooks, and MCP
// servers. Discovery-only for ALL SIX — a source never contributes
// agent-loadable tools, and everything but skills is catalogued for display
// only, never invoked/executed/spawned.
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
        let commandCount: Int
        let templateCount: Int
        let hookCount: Int
        let mcpCount: Int
        let enabled: Bool
        /// How many skills/agents/commands/templates this user unchecked inside
        /// the source (server v56+; 0 from an older server).
        let disabledItemCount: Int

        enum CodingKeys: String, CodingKey {
            case id, name, origin, location, builtin, version, ref, installed
            case skillCount, agentCount, commandCount, templateCount, hookCount, mcpCount, enabled
            case disabledItemCount
        }
        /// `agentCount`/`hookCount`/`mcpCount` arrived with the v28 MCP bump
        /// (v27 renamed the endpoints but didn't carry them), and
        /// `commandCount`/`templateCount` later still. Decode every count with
        /// a fallback so an app paired with a not-yet-restarted older server
        /// still decodes the list instead of throwing `keyNotFound` and
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
            self.commandCount  = try c.decodeIfPresent(Int.self, forKey: .commandCount) ?? 0
            self.templateCount = try c.decodeIfPresent(Int.self, forKey: .templateCount) ?? 0
            self.hookCount  = try c.decodeIfPresent(Int.self, forKey: .hookCount) ?? 0
            self.mcpCount   = try c.decodeIfPresent(Int.self, forKey: .mcpCount) ?? 0
            self.enabled    = try c.decode(Bool.self, forKey: .enabled)
            self.disabledItemCount = try c.decodeIfPresent(Int.self, forKey: .disabledItemCount) ?? 0
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

    /// The four kinds a user can check/uncheck inside a source. Hooks and MCP
    /// servers stay whole-source (their own trust/consent gates apply).
    enum LlmSourceItemKind: String, Encodable, CaseIterable {
        case skill, agent, command, template
    }

    /// One catalogued skill, agent (subagent definition), command
    /// (`commands/*.md`, invoked by name), or template (`templates/*.md`, a
    /// fill-in document) found in a source — all four share this shape.
    /// `enabled` is this user's checkbox and `isNew` marks an item the last
    /// update added; both arrived in server v56 and default to checked /
    /// not-new so an older server still decodes.
    struct LlmSourceItem: Decodable, Identifiable, Equatable {
        let name: String
        let description: String
        let path: String
        var enabled: Bool
        let isNew: Bool
        var id: String { path }

        enum CodingKeys: String, CodingKey { case name, description, path, enabled, isNew }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
            path = try c.decode(String.self, forKey: .path)
            enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
            isNew = try c.decodeIfPresent(Bool.self, forKey: .isNew) ?? false
        }
    }
    typealias LlmSourceSkill = LlmSourceItem
    typealias LlmSourceAgent = LlmSourceItem
    typealias LlmSourceCommand = LlmSourceItem
    typealias LlmSourceTemplate = LlmSourceItem
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
        /// Optional for the same reason as `skills`: these two families were
        /// added to the discovery response after agents/hooks/mcpServers.
        let commands: [LlmSourceCommand]?
        let templates: [LlmSourceTemplate]?
        let hooks: [LlmSourceHook]
        let mcpServers: [LlmSourceMcpServer]
    }

    /// Whether a source changed upstream — `GET /auth/me/llm-sources/updates`.
    /// `status` is kept as the raw string (update-available | up-to-date |
    /// local | diverged | unknown) so a new server status can't break decode.
    struct LlmSourceUpdateStatus: Decodable, Equatable {
        let id: String
        let status: String
        let localRev: String?
        let remoteRev: String?
        let checkedAt: String?
        let message: String?
        var updateAvailable: Bool { status == "update-available" }
        /// A local folder: no remote to compare, so the action is Rescan.
        var isLocal: Bool { status == "local" }
    }
    private struct UpdateStatusesResponse: Decodable { let sources: [LlmSourceUpdateStatus] }

    /// What `POST …/update` did. Every field past `ok` is server v56+ and
    /// defaults to empty, so an older server's `{ ok, installed }` decodes.
    struct LlmSourceUpdateResult: Decodable, Equatable {
        struct ItemRef: Decodable, Equatable { let kind: String; let name: String }
        let ok: Bool
        let installed: Bool?
        let fromRev: String?
        let toRev: String?
        let added: [ItemRef]
        let removed: [ItemRef]
        let corrected: [String]

        enum CodingKeys: String, CodingKey { case ok, installed, fromRev, toRev, added, removed, corrected }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
            installed = try c.decodeIfPresent(Bool.self, forKey: .installed)
            fromRev = try c.decodeIfPresent(String.self, forKey: .fromRev)
            toRev = try c.decodeIfPresent(String.self, forKey: .toRev)
            added = try c.decodeIfPresent([ItemRef].self, forKey: .added) ?? []
            removed = try c.decodeIfPresent([ItemRef].self, forKey: .removed) ?? []
            corrected = try c.decodeIfPresent([String].self, forKey: .corrected) ?? []
        }

        var changed: Bool {
            !added.isEmpty || !removed.isEmpty || (fromRev != nil && toRev != nil && fromRev != toRev)
        }

        /// One human sentence for the post-update alert. `projectSkills` names
        /// the project whose installed skills were re-linked afterwards.
        func summary(sourceName: String, projectSkills: String?) -> String {
            guard changed || !corrected.isEmpty else { return "\(sourceName) is up to date — nothing changed." }
            func label(_ i: ItemRef) -> String { i.kind == "command" ? "/\(i.name) command" : "\(i.name) \(i.kind)" }
            var parts: [String] = []
            if !added.isEmpty { parts.append("\(added.count) added (\(added.map(label).joined(separator: ", ")))") }
            if !removed.isEmpty { parts.append("\(removed.count) removed (\(removed.map(label).joined(separator: ", ")))") }
            var text = "\(sourceName) updated" + (parts.isEmpty ? "." : ": " + parts.joined(separator: "; ") + ".")
            let fixed = corrected + (projectSkills.map { ["project skills (\($0))"] } ?? [])
            if !fixed.isEmpty { text += " Corrected: " + fixed.joined(separator: ", ") + "." }
            return text
        }
    }

    private struct ToggleAck: Decodable { let ok: Bool; let enabled: Bool }
    private struct ItemsAck: Decodable { let ok: Bool; let disabled: [String] }
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

    /// Pull a source to its latest upstream and repair what depends on it
    /// (git: fetch + move to FETCH_HEAD; Central Skills: fast-forward only,
    /// then `.skills-lock` + synced tool definitions; local: rescan). Refuses
    /// (409, surfaced as `APIError.http`) rather than discard uncommitted
    /// edits or local-only commits. Admin-gated server-side.
    @discardableResult
    func updateLlmSource(id: String) async throws -> LlmSourceUpdateResult {
        struct Req: Encodable { let id: String }
        return try await post("/auth/me/llm-sources/update", body: Req(id: id), authenticated: true)
    }

    /// Upstream status for every source. `force` skips the server's 30-minute cache.
    func llmSourceUpdates(force: Bool = false) async throws -> [LlmSourceUpdateStatus] {
        let resp: UpdateStatusesResponse = try await get(
            "/auth/me/llm-sources/updates\(force ? "?force=1" : "")", authenticated: true)
        return resp.sources
    }

    /// Check or uncheck items inside a source (per user). Returns the source's
    /// full unchecked set as `<kind>:<name>` keys.
    @discardableResult
    func setLlmSourceItems(sourceId: String, kind: LlmSourceItemKind, names: [String], enabled: Bool) async throws -> [String] {
        struct Req: Encodable { let sourceId: String; let kind: LlmSourceItemKind; let names: [String]; let enabled: Bool }
        let ack: ItemsAck = try await post("/auth/me/llm-sources/items",
                                           body: Req(sourceId: sourceId, kind: kind, names: names, enabled: enabled),
                                           authenticated: true)
        return ack.disabled
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

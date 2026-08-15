import Foundation

// MCP plugin registry — GET/POST/DELETE /auth/me/mcp-plugins/*. Mirrors
// extension/mcp/state.mjs + mcp-config.mjs. A registered server reaches the
// Claude CLI's --mcp-config only once a user has both consented AND enabled
// it (per-user gates, same shape as llm-sources' per-user `enabled`). See
// docs/superpowers/specs/2026-08-12-mcp-plugin-runtime-design.md.
extension LlmIdeAPIClient {

    struct McpPluginInfo: Decodable, Identifiable, Equatable {
        let id: String
        let name: String
        let command: String
        let args: [String]
        let env: [String: String]?
        let source: String       // "claude" | "manual"
        let builtin: Bool
        let enabled: Bool
        let consented: Bool

        enum CodingKeys: String, CodingKey {
            case id, name, command, args, env, source, builtin, enabled, consented
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = try c.decode(String.self, forKey: .id)
            self.name = try c.decode(String.self, forKey: .name)
            self.command = try c.decode(String.self, forKey: .command)
            self.args = try c.decodeIfPresent([String].self, forKey: .args) ?? []
            self.env = try c.decodeIfPresent([String: String].self, forKey: .env)
            self.source = try c.decodeIfPresent(String.self, forKey: .source) ?? "manual"
            self.builtin = try c.decodeIfPresent(Bool.self, forKey: .builtin) ?? false
            self.enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
            self.consented = try c.decodeIfPresent(Bool.self, forKey: .consented) ?? false
        }
    }
    private struct McpPluginListResponse: Decodable { let plugins: [McpPluginInfo] }

    struct McpPluginSummary: Decodable {
        let id: String
        let name: String
        let command: String
        let args: [String]
        let env: [String: String]?
        let source: String
        let builtin: Bool
    }
    private struct AddMcpPluginResponse: Decodable { let plugin: McpPluginSummary }

    /// One server discovered by the admin-only read-only scan of the
    /// operator's `~/.claude.json` — never written to, an import source only.
    struct ClaudeMcpSource: Decodable, Identifiable, Equatable {
        let name: String
        let command: String
        let args: [String]
        let env: [String: String]?
        var id: String { name }
    }
    private struct ClaudeMcpSourcesResponse: Decodable { let servers: [ClaudeMcpSource] }

    /// Same as ClaudeMcpSource, scanned from `~/.codex/config.toml`'s
    /// `[mcp_servers.*]` tables instead (mcp/codex-source.mjs).
    struct CodexMcpSource: Decodable, Identifiable, Equatable {
        let name: String
        let command: String
        let args: [String]
        let env: [String: String]?
        var id: String { name }
    }
    private struct CodexMcpSourcesResponse: Decodable { let servers: [CodexMcpSource] }

    private struct ConsentAck: Decodable { let ok: Bool; let consented: Bool }
    private struct ToggleAck: Decodable { let ok: Bool; let enabled: Bool }
    private struct RemoveAck: Decodable { let ok: Bool }

    /// All registered MCP plugins with this user's own consent/enable state.
    func listMcpPlugins() async throws -> [McpPluginInfo] {
        let resp: McpPluginListResponse = try await get("/auth/me/mcp-plugins", authenticated: true)
        return resp.plugins
    }

    /// Admin-only: read-only scan of the operator's `~/.claude.json` for
    /// MCP servers not yet registered here.
    func scanClaudeMcpSources() async throws -> [ClaudeMcpSource] {
        let resp: ClaudeMcpSourcesResponse = try await get("/auth/me/mcp-plugins/claude-sources", authenticated: true)
        return resp.servers
    }

    /// Admin-only: read-only scan of the operator's `~/.codex/config.toml`
    /// for MCP servers not yet registered here.
    func scanCodexMcpSources() async throws -> [CodexMcpSource] {
        let resp: CodexMcpSourcesResponse = try await get("/auth/me/mcp-plugins/codex-sources", authenticated: true)
        return resp.servers
    }

    /// Register a new server. Pass `claudeName`/`codexName` to import a
    /// server one of the scans found (server resolves its command/args/env);
    /// otherwise supply `command`/`args`/`env` directly for a manual entry.
    /// Admin-gated server-side — a non-admin caller sees `APIError.http(status: 403, …)`.
    @discardableResult
    func addMcpPlugin(claudeName: String? = nil, codexName: String? = nil, command: String? = nil, args: [String]? = nil,
                       env: [String: String]? = nil, name: String? = nil, source: String? = nil) async throws -> McpPluginSummary {
        struct Req: Encodable {
            let claudeName: String?
            let codexName: String?
            let command: String?
            let args: [String]?
            let env: [String: String]?
            let name: String?
            let source: String?
        }
        let resp: AddMcpPluginResponse = try await post("/auth/me/mcp-plugins/add",
                                                          body: Req(claudeName: claudeName, codexName: codexName, command: command, args: args, env: env, name: name, source: source),
                                                          authenticated: true)
        return resp.plugin
    }

    /// Per-user consent — required (alongside `toggleMcpPlugin`'s enable) before
    /// the server includes this plugin in the Claude CLI's `--mcp-config`.
    @discardableResult
    func consentMcpPlugin(id: String, consented: Bool) async throws -> Bool {
        struct Req: Encodable { let id: String; let consented: Bool }
        let ack: ConsentAck = try await post("/auth/me/mcp-plugins/consent",
                                              body: Req(id: id, consented: consented),
                                              authenticated: true)
        return ack.consented
    }

    /// Per-user enable — not admin-gated, mirrors `toggleLlmSource`.
    @discardableResult
    func toggleMcpPlugin(id: String, enabled: Bool) async throws -> Bool {
        struct Req: Encodable { let id: String; let enabled: Bool }
        let ack: ToggleAck = try await post("/auth/me/mcp-plugins/toggle",
                                             body: Req(id: id, enabled: enabled),
                                             authenticated: true)
        return ack.enabled
    }

    /// Remove a registered server. Admin-gated server-side.
    func removeMcpPlugin(id: String) async throws {
        let _: RemoveAck = try await delete("/auth/me/mcp-plugins/\(percentEncoded(id))", authenticated: true)
    }
}

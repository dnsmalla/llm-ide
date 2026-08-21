import Foundation

// MCP plugin registry — GET/POST/DELETE /auth/me/mcp-plugins/*. Mirrors
// extension/mcp/state.mjs + mcp-config.mjs. A registered server reaches the
// Claude CLI's --mcp-config only once a user has both consented AND enabled
// it (per-user gates, same shape as llm-sources' per-user `enabled`). See
// docs/superpowers/specs/2026-08-12-mcp-plugin-runtime-design.md.
extension LlmIdeAPIClient {

    /// Descriptor for a credential a server needs. Never carries the value —
    /// that lives in the encrypted vault under `vaultKey` and is injected
    /// server-side when `--mcp-config` is built.
    struct McpCredentialInfo: Decodable, Equatable {
        let vaultKey: String
        let target: String        // "env" | "header"
        let name: String
        let label: String?
    }

    struct McpPluginInfo: Decodable, Identifiable, Equatable {
        let id: String
        let name: String
        /// "stdio" | "http" | "sse". Absent on records written before
        /// transports existed, which were always stdio.
        let transport: String
        /// stdio only — a hosted server has none, which is why this had to
        /// stop being a required field: decoding the list threw outright once
        /// a single hosted server was registered.
        let command: String?
        let args: [String]
        let env: [String: String]?
        /// http/sse only.
        let url: String?
        /// Values arrive redacted (`••••`); names are real.
        let headers: [String: String]?
        let credential: McpCredentialInfo?
        /// Server-computed: this plugin declares a credential the vault has no
        /// value for, so it will fail to authenticate until one is stored.
        let credentialMissing: Bool
        let source: String       // "claude" | "codex" | "catalog" | "manual"
        let builtin: Bool
        let enabled: Bool
        let consented: Bool

        var isHosted: Bool { transport == "http" || transport == "sse" }
        /// One line describing how this server is reached, for the row/detail.
        var endpointSummary: String {
            if isHosted { return url ?? "(no url)" }
            return ([command ?? "(no command)"] + args).joined(separator: " ")
        }

        enum CodingKeys: String, CodingKey {
            case id, name, transport, command, args, env, url, headers
            case credential, credentialMissing, source, builtin, enabled, consented
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = try c.decode(String.self, forKey: .id)
            self.name = try c.decode(String.self, forKey: .name)
            self.transport = try c.decodeIfPresent(String.self, forKey: .transport) ?? "stdio"
            self.command = try c.decodeIfPresent(String.self, forKey: .command)
            self.args = try c.decodeIfPresent([String].self, forKey: .args) ?? []
            self.env = try c.decodeIfPresent([String: String].self, forKey: .env)
            self.url = try c.decodeIfPresent(String.self, forKey: .url)
            self.headers = try c.decodeIfPresent([String: String].self, forKey: .headers)
            self.credential = try c.decodeIfPresent(McpCredentialInfo.self, forKey: .credential)
            self.credentialMissing = try c.decodeIfPresent(Bool.self, forKey: .credentialMissing) ?? false
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
        let transport: String?
        let command: String?
        let args: [String]?
        let env: [String: String]?
        let url: String?
        let source: String
        let builtin: Bool
    }
    private struct AddMcpPluginResponse: Decodable { let plugin: McpPluginSummary }

    /// One server discovered by the admin-only read-only scan of the
    /// operator's `~/.claude.json` — never written to, an import source only.
    struct ClaudeMcpSource: Decodable, Identifiable, Equatable {
        let name: String
        let transport: String?
        /// Absent for a hosted entry. These used to be dropped by the scanner
        /// entirely, so a config whose only servers were remote scanned empty.
        let command: String?
        let args: [String]?
        let env: [String: String]?
        let url: String?
        var id: String { name }
        var isHosted: Bool { transport == "http" || transport == "sse" }
    }
    private struct ClaudeMcpSourcesResponse: Decodable { let servers: [ClaudeMcpSource] }

    /// Same as ClaudeMcpSource, scanned from `~/.codex/config.toml`'s
    /// `[mcp_servers.*]` tables instead (mcp/codex-source.mjs).
    struct CodexMcpSource: Decodable, Identifiable, Equatable {
        let name: String
        let transport: String?
        let command: String?
        let args: [String]?
        let env: [String: String]?
        let url: String?
        var id: String { name }
        var isHosted: Bool { transport == "http" || transport == "sse" }
    }
    private struct CodexMcpSourcesResponse: Decodable { let servers: [CodexMcpSource] }

    /// One curated, one-click-addable server (extension/mcp/catalog.mjs).
    struct McpCatalogEntry: Decodable, Identifiable, Equatable {
        let id: String
        let name: String
        let description: String
        let transport: String
        let command: String?
        let args: [String]?
        let url: String?
        let credential: McpCredentialInfo?
        /// Signed in through the CLI's browser flow (`claude mcp login <name>`)
        /// rather than a token we hold — so do NOT prompt for a credential.
        let oauth: Bool
        /// Declares a trailing argument the server cannot work without
        /// (filesystem's directory, DBHub's DSN).
        let requiresArg: RequiredArg?
        /// Already in this install's registry — offer it as added, not addable.
        let registered: Bool

        struct RequiredArg: Decodable, Equatable {
            let label: String
            let placeholder: String?
        }

        var isHosted: Bool { transport == "http" || transport == "sse" }

        enum CodingKeys: String, CodingKey {
            case id, name, description, transport, command, args, url
            case credential, oauth, requiresArg, registered
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = try c.decode(String.self, forKey: .id)
            self.name = try c.decode(String.self, forKey: .name)
            self.description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
            self.transport = try c.decodeIfPresent(String.self, forKey: .transport) ?? "stdio"
            self.command = try c.decodeIfPresent(String.self, forKey: .command)
            self.args = try c.decodeIfPresent([String].self, forKey: .args)
            self.url = try c.decodeIfPresent(String.self, forKey: .url)
            self.credential = try c.decodeIfPresent(McpCredentialInfo.self, forKey: .credential)
            self.oauth = try c.decodeIfPresent(Bool.self, forKey: .oauth) ?? false
            self.requiresArg = try c.decodeIfPresent(RequiredArg.self, forKey: .requiresArg)
            self.registered = try c.decodeIfPresent(Bool.self, forKey: .registered) ?? false
        }
    }
    private struct McpCatalogResponse: Decodable { let servers: [McpCatalogEntry] }

    private struct ConsentAck: Decodable { let ok: Bool; let consented: Bool }
    private struct ToggleAck: Decodable { let ok: Bool; let enabled: Bool }
    private struct RemoveAck: Decodable { let ok: Bool }

    /// All registered MCP plugins with this user's own consent/enable state.
    func listMcpPlugins() async throws -> [McpPluginInfo] {
        let resp: McpPluginListResponse = try await get("/auth/me/mcp-plugins", authenticated: true)
        return resp.plugins
    }

    /// The curated catalog of servers worth one-clicking. Static server-side,
    /// but each entry is marked `registered` for what this install already has.
    func fetchMcpCatalog() async throws -> [McpCatalogEntry] {
        let resp: McpCatalogResponse = try await get("/auth/me/mcp-plugins/catalog", authenticated: true)
        return resp.servers
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

    /// Register a new server. Four ways in, resolved server-side in this order:
    /// `catalogId` (+ `arg` when the entry requires one) picks a curated
    /// catalog entry; `claudeName`/`codexName` import what a scan found;
    /// otherwise supply `command`/`args`/`env` for a local server or
    /// `url`/`headers` for a hosted one.
    @discardableResult
    func addMcpPlugin(claudeName: String? = nil, codexName: String? = nil, catalogId: String? = nil,
                      arg: String? = nil, command: String? = nil, args: [String]? = nil,
                      env: [String: String]? = nil, url: String? = nil, headers: [String: String]? = nil,
                      transport: String? = nil, name: String? = nil, source: String? = nil) async throws -> McpPluginSummary {
        struct Req: Encodable {
            let claudeName: String?
            let codexName: String?
            let catalogId: String?
            let arg: String?
            let command: String?
            let args: [String]?
            let env: [String: String]?
            let url: String?
            let headers: [String: String]?
            let transport: String?
            let name: String?
            let source: String?
        }
        let resp: AddMcpPluginResponse = try await post(
            "/auth/me/mcp-plugins/add",
            body: Req(claudeName: claudeName, codexName: codexName, catalogId: catalogId, arg: arg,
                      command: command, args: args, env: env, url: url, headers: headers,
                      transport: transport, name: name, source: source),
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

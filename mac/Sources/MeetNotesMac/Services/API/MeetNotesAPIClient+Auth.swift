import Foundation

extension MeetNotesAPIClient {

    // Per-user UI preferences, synced server-side via /auth/me/prefs.
    // Both the Chrome extension and Mac app read this on login and PUT
    // on change so a language switch in one client follows the user to
    // the other.  Allow-listed keys today: language, bilingual.
    struct UserPrefs: Codable, Equatable {
        var language: String?
        var bilingual: Bool?
    }
    struct UserPrefsWrap: Codable { let prefs: UserPrefs }

    struct UserRepo: Codable, Identifiable {
        let path: String
        let label: String?
        let addedAt: String?
        var id: String { path }
    }
    struct UserReposWrap: Codable { let repos: [UserRepo] }

    struct SecretKey: Codable {
        let key: String
        let updatedAt: String?
    }
    struct SecretsListResponse: Codable {
        let secrets: [SecretKey]
        let available: [String]
    }

    // --- Auth methods -------------------------------------------------

    func login(email: String, password: String) async throws -> SessionResponse {
        try await post("/auth/login", body: LoginRequest(email: email, password: password), authenticated: false)
    }

    func register(email: String, password: String, displayName: String?) async throws -> [String: UserInfo] {
        try await post("/auth/register", body: RegisterRequest(email: email, password: password, displayName: displayName), authenticated: false)
    }

    func refresh(refreshToken: String) async throws -> SessionResponse {
        try await post("/auth/refresh", body: RefreshRequest(refreshToken: refreshToken), authenticated: false)
    }

    func getUserPrefs() async throws -> UserPrefs {
        let r: UserPrefsWrap = try await get("/auth/me/prefs", authenticated: true)
        return r.prefs
    }

    @discardableResult
    func setUserPrefs(_ patch: UserPrefs) async throws -> UserPrefs {
        let r: UserPrefsWrap = try await put("/auth/me/prefs", body: patch, authenticated: true)
        return r.prefs
    }

    func listUserRepos() async throws -> [UserRepo] {
        let r: UserReposWrap = try await get("/auth/me/repos", authenticated: true)
        return r.repos
    }

    func listSecretKeys() async throws -> SecretsListResponse {
        try await get("/auth/me/secrets", authenticated: true)
    }

    // MARK: - Plugins

    func listPlugins() async throws -> PluginsListResponse {
        try await get("/auth/me/plugins", authenticated: true)
    }

    func togglePlugin(name: String, enabled: Bool) async throws {
        struct Req: Encodable { let name: String; let enabled: Bool }
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await post("/auth/me/plugins/toggle",
                                    body: Req(name: name, enabled: enabled),
                                    authenticated: true)
    }

    func reloadPlugins() async throws -> PluginReloadResponse {
        struct Empty: Encodable {}
        return try await post("/auth/me/plugins/reload",
                              body: Empty(),
                              authenticated: true)
    }

    /// Install a plugin from a zip on disk. Optionally overwrite an
    /// existing same-named plugin. Returns the installer's report so
    /// the UI can surface "Installed @foo (1 skill, 2 commands)".
    func installPlugin(zipURL: URL, replace: Bool = false) async throws -> PluginInstallResponse {
        let data = try Data(contentsOf: zipURL)
        let path = "/auth/me/plugins/install" + (replace ? "?replace=1" : "")
        return try await postRawBytes(path, bytes: data,
                                      contentType: "application/zip",
                                      authenticated: true)
    }

    /// Remove an installed plugin by slug. Idempotent — removing
    /// something that isn't there returns ok: true, removed: false.
    func uninstallPlugin(name: String) async throws -> PluginUninstallResponse {
        guard let slug = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else { throw APIError.invalidURL }
        return try await delete("/auth/me/plugins/uninstall/\(slug)", authenticated: true)
    }

    // MARK: - Claude Plugin Bridge

    func listClaudeInstalled() async throws -> ClaudePluginsListResponse {
        try await get("/auth/me/claude-plugins/installed", authenticated: true)
    }

    func listClaudeMarketplace() async throws -> ClaudeMarketplaceListResponse {
        try await get("/auth/me/claude-plugins/marketplace", authenticated: true)
    }

    func importClaudePlugin(name: String, source: String) async throws -> ClaudeImportResponse {
        struct Req: Encodable { let name: String; let source: String }
        return try await post("/auth/me/claude-plugins/import",
                              body: Req(name: name, source: source),
                              authenticated: true)
    }

}

struct PluginInstallResponse: Decodable {
    let ok: Bool
    let plugin: InstalledPluginSummary
    struct InstalledPluginSummary: Decodable {
        let name: String
        let version: String
        let displayName: String
        let description: String
        let author: String
        let skillCount: Int
        let commandCount: Int
        let subagentCount: Int
        let replaced: Bool
    }
}

struct PluginUninstallResponse: Decodable {
    let ok: Bool
    let removed: Bool
}

// MARK: - Plugin DTOs

struct PluginCommandInfo: Decodable, Identifiable {
    let trigger: String
    let description: String
    var id: String { trigger }
}

struct PluginSubagentInfo: Decodable, Identifiable {
    let name: String
    let description: String
    let allowedTools: [String]
    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, description, allowedTools
    }
}

struct PluginInfo: Decodable, Identifiable, Equatable {
    let name: String
    let version: String
    let displayName: String
    let description: String
    let author: String
    let enabled: Bool
    let skillCount: Int
    let commands: [PluginCommandInfo]
    /// Subagents declared by the plugin under `agents/`. Default empty
    /// so older server responses without this field still decode.
    let subagents: [PluginSubagentInfo]
    var id: String { name }
    static func == (lhs: PluginInfo, rhs: PluginInfo) -> Bool { lhs.name == rhs.name && lhs.enabled == rhs.enabled }

    enum CodingKeys: String, CodingKey {
        case name, version, displayName, description, author
        case enabled, skillCount, commands, subagents
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name        = try c.decode(String.self, forKey: .name)
        self.version     = try c.decode(String.self, forKey: .version)
        self.displayName = try c.decode(String.self, forKey: .displayName)
        self.description = try c.decode(String.self, forKey: .description)
        self.author      = try c.decode(String.self, forKey: .author)
        self.enabled     = try c.decode(Bool.self,   forKey: .enabled)
        self.skillCount  = try c.decode(Int.self,    forKey: .skillCount)
        self.commands    = try c.decode([PluginCommandInfo].self, forKey: .commands)
        self.subagents   = try c.decodeIfPresent([PluginSubagentInfo].self, forKey: .subagents) ?? []
    }
}

struct PluginsListResponse: Decodable {
    let pluginDir: String
    let plugins: [PluginInfo]
}

struct PluginReloadResponse: Decodable {
    let pluginDir: String
    let count: Int
    let warnings: [String]
}

// MARK: - Claude Plugin Bridge DTOs

struct ClaudePlugin: Decodable, Identifiable {
    let name: String
    let version: String
    let marketplace: String
    let installPath: String?
    let skillCount: Int
    let commandCount: Int
    var alreadyImported: Bool
    let importedVersion: String?
    var id: String { name }

    /// True when the source version differs from the imported version.
    var hasUpdate: Bool {
        guard alreadyImported, let iv = importedVersion else { return false }
        return iv != version
    }

    enum CodingKeys: String, CodingKey {
        case name, version, marketplace, installPath, skillCount, commandCount, alreadyImported, importedVersion
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.version = try c.decodeIfPresent(String.self, forKey: .version) ?? "0.0.0"
        self.marketplace = try c.decodeIfPresent(String.self, forKey: .marketplace) ?? "unknown"
        self.installPath = try c.decodeIfPresent(String.self, forKey: .installPath)
        self.skillCount = try c.decodeIfPresent(Int.self, forKey: .skillCount) ?? 0
        self.commandCount = try c.decodeIfPresent(Int.self, forKey: .commandCount) ?? 0
        self.alreadyImported = try c.decodeIfPresent(Bool.self, forKey: .alreadyImported) ?? false
        self.importedVersion = try c.decodeIfPresent(String.self, forKey: .importedVersion)
    }
}

struct ClaudeMarketplacePlugin: Decodable, Identifiable {
    let name: String
    let marketplace: String
    let description: String
    let hasSkills: Bool
    let hasCommands: Bool
    var installedInClaude: Bool
    var alreadyImported: Bool
    let importedVersion: String?
    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, marketplace, description, hasSkills, hasCommands, installedInClaude, alreadyImported, importedVersion
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.marketplace = try c.decodeIfPresent(String.self, forKey: .marketplace) ?? "unknown"
        self.description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        self.hasSkills = try c.decodeIfPresent(Bool.self, forKey: .hasSkills) ?? false
        self.hasCommands = try c.decodeIfPresent(Bool.self, forKey: .hasCommands) ?? false
        self.installedInClaude = try c.decodeIfPresent(Bool.self, forKey: .installedInClaude) ?? false
        self.alreadyImported = try c.decodeIfPresent(Bool.self, forKey: .alreadyImported) ?? false
        self.importedVersion = try c.decodeIfPresent(String.self, forKey: .importedVersion)
    }
}

struct ClaudePluginsListResponse: Decodable {
    let plugins: [ClaudePlugin]
}

struct ClaudeMarketplaceListResponse: Decodable {
    let plugins: [ClaudeMarketplacePlugin]
}

struct ClaudeImportResponse: Decodable {
    let ok: Bool
    let plugin: ImportedPluginInfo?
    let error: String?
    struct ImportedPluginInfo: Decodable {
        let name: String
        let version: String
        let displayName: String
        let skillCount: Int
        let commandCount: Int
    }
}


import Foundation
import os.log

extension LlmIdeAPIClient {
    private static let pluginInstallLog = Logger(subsystem: "com.llmide.macapp", category: "PluginInstall")

    // Per-user UI preferences, synced server-side via /auth/me/prefs.
    // Both the Chrome extension and Mac app read this on login and PUT
    // on change so a language switch in one client follows the user to
    // the other.  Allow-listed keys today: language, bilingual, nativePlugins.
    struct UserPrefs: Codable, Equatable {
        var language: String?
        var bilingual: Bool?
        /// Hand Claude-format plugins to the Agent SDK to load themselves
        /// (skills, commands, agents, and their hooks at full fidelity) instead
        /// of llm-ide translating their `command` hooks. `nil` means unset,
        /// which the server treats as ON — see `nativePluginsEnabled`.
        var nativePlugins: Bool?
    }
    struct UserPrefsWrap: Codable { let prefs: UserPrefs }

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

    /// Fetch the signed-in user's profile. Used to complete a launch
    /// refresh against an older server whose /auth/refresh response
    /// omits `user` — without it the tokens adopt but the UI stays on
    /// the login screen (`isAuthenticated` requires a non-nil user).
    func me() async throws -> UserInfo {
        try await get("/auth/me", authenticated: true)
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

    /// Register a local repo path on the user's allow-list. Required before
    /// `connectGit` (which 403s otherwise). Idempotent server-side. Returns the
    /// canonical absolute path the server stored.
    @discardableResult
    func addUserRepo(path: String, label: String? = nil) async throws -> String {
        struct Req: Encodable { let path: String; let label: String? }
        struct Resp: Decodable { let ok: Bool; let path: String }
        let r: Resp = try await post("/auth/me/repos", body: Req(path: path, label: label), authenticated: true)
        return r.path
    }

    struct ConnectGitResult: Decodable {
        let ok: Bool
        let filesScanned: Int?
        let filesIndexed: Int?
        let chunks: Int?
    }

    /// Ingest a local repo's code into the KB `sources` corpus (local FTS,
    /// no network/LLM) so the agent can search it via search-kb / findContext.
    /// The path must already be allow-listed (see `addUserRepo`).
    @discardableResult
    func connectGit(path: String, replace: Bool = true) async throws -> ConnectGitResult {
        struct Req: Encodable { let path: String; let replace: Bool }
        return try await post("/kb/connect-git", body: Req(path: path, replace: replace), authenticated: true)
    }

    // MARK: - Plugins

    func listPlugins() async throws -> PluginsListResponse {
        try await get("/auth/me/plugins", authenticated: true)
    }

    /// Authorize (or revoke) shell execution for one plugin's hooks. Separate
    /// from `togglePlugin` on purpose — the server audits it as its own grant.
    ///
    /// `shownKinds` is what the detail view displayed when the user clicked. The
    /// server refuses (409) a grant for a plugin that has since declared more, so
    /// a grant is never larger than what the user saw.
    func setPluginHookTrust(name: String, trusted: Bool, shownKinds: [String]? = nil) async throws -> Bool {
        struct Req: Encodable { let name: String; let trusted: Bool; let kinds: [String]? }
        struct Ack: Decodable { let ok: Bool; let hooksTrusted: Bool }
        let ack: Ack = try await post("/auth/me/plugins/hook-trust",
                                      body: Req(name: name, trusted: trusted, kinds: shownKinds),
                                      authenticated: true)
        return ack.hooksTrusted
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
    ///
    /// `source` is where the package came from; the server records it so
    /// updates can be checked later. A value the server would refuse is not
    /// sent (the install still happens), and if the server refuses it anyway
    /// (`INVALID_SOURCE`) the install is retried once without it — provenance
    /// must never be the reason an install fails.
    ///
    /// On a replace a zip record stands in when `source` cannot be sent (see
    /// `PluginInstallSource.installPlan`).
    ///
    /// `expectName` is the plugin an update means to replace: the server
    /// refuses (409 NAME_MISMATCH, nothing installed) a package that names
    /// another one. Every update path sends it.
    func installPlugin(zipURL: URL, replace: Bool = false,
                       source: PluginInstallSource? = nil,
                       fallbackFileName: String? = nil,
                       expectName: String? = nil) async throws -> PluginInstallResponse {
        let data = try Data(contentsOf: zipURL)
        var query: [String] = replace ? ["replace=1"] : []
        if let expectName {
            let encoded = expectName.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? expectName
            query.append("expect=\(encoded)")
        }
        let path = "/auth/me/plugins/install" + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
        let plan = PluginInstallSource.installPlan(
            source: source, replace: replace, fallbackFileName: fallbackFileName ?? zipURL.lastPathComponent)
        if let source, plan.first != source {
            Self.pluginInstallLog.notice("install source (\(source.kind, privacy: .public)) not recordable; installing without it")
        }
        let headers = Self.sourceHeaders(plan.first)
        let response: PluginInstallResponse
        do {
            response = try await postRawBytes(
                path, bytes: data, contentType: "application/zip", authenticated: true, headers: headers)
        } catch APIError.http(400, "INVALID_SOURCE", let message, _) where !headers.isEmpty {
            Self.pluginInstallLog.warning("server refused install source: \(message, privacy: .public); retrying")
            response = try await postRawBytes(
                path, bytes: data, contentType: "application/zip", authenticated: true,
                headers: Self.sourceHeaders(plan.retry))
        }
        // A newly installed plugin may declare a graph engine, and the resolved
        // engine is cached for the process. Without this the app kept reporting
        // "No graph engine installed" — pointing the user at the very screen
        // they had just used — until a relaunch.
        await MainActor.run { FeatureCatalog.invalidateGraphEngineCache() }
        return response
    }

    private static func sourceHeaders(_ source: PluginInstallSource?) -> [String: String] {
        guard let source, let value = try? source.headerValue() else { return [:] }
        return ["X-Llmide-Plugin-Source": value]
    }

    /// Remove an installed plugin by slug. Idempotent — removing
    /// something that isn't there returns ok: true, removed: false.
    func uninstallPlugin(name: String) async throws -> PluginUninstallResponse {
        guard let slug = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else { throw APIError.invalidURL }
        let response: PluginUninstallResponse = try await delete(
            "/auth/me/plugins/uninstall/\(slug)", authenticated: true)
        // Drop a cached engine that may now point at a deleted directory —
        // otherwise generation failed with "wrote no graph" instead of the
        // clean "no engine installed" message.
        await MainActor.run { FeatureCatalog.invalidateGraphEngineCache() }
        return response
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

    // MARK: - Codex Plugin Bridge

    func listCodexInstalled() async throws -> CodexPluginsListResponse {
        try await get("/auth/me/codex-plugins/installed", authenticated: true)
    }

    func listCodexMarketplace() async throws -> CodexMarketplaceListResponse {
        try await get("/auth/me/codex-plugins/marketplace", authenticated: true)
    }

    func importCodexPlugin(name: String, source: String) async throws -> CodexImportResponse {
        struct Req: Encodable { let name: String; let source: String }
        return try await post("/auth/me/codex-plugins/import",
                              body: Req(name: name, source: source),
                              authenticated: true)
    }

    // MARK: - Vendor plugin updates
    //
    // Both bridges expose the same two shapes, so the client does too: refresh
    // re-scans the vendor's own directories, updates compares what was
    // imported against what the source now offers.

    func refreshClaudeSources() async throws -> PluginRefreshResponse {
        try await post("/auth/me/claude-plugins/refresh", body: EmptyBody(), authenticated: true)
    }

    func claudePluginUpdates() async throws -> [PluginUpdate] {
        let response: PluginUpdatesResponse = try await get("/auth/me/claude-plugins/updates", authenticated: true)
        return response.updates
    }

    func refreshCodexSources() async throws -> PluginRefreshResponse {
        try await post("/auth/me/codex-plugins/refresh", body: EmptyBody(), authenticated: true)
    }

    func codexPluginUpdates() async throws -> [PluginUpdate] {
        let response: PluginUpdatesResponse = try await get("/auth/me/codex-plugins/updates", authenticated: true)
        return response.updates
    }

    // MARK: - One-click plugin update (server API v60+)
    //
    // The calls above are the pre-v60 shapes and stay for older servers. These
    // read the tiered check and drive `POST /auth/me/claude-plugins/update`,
    // which updates Claude Code's own install and then re-imports it.

    /// Server-side deadline is three `claude plugin …` runs of 120 s each
    /// (list, update, list); the client waits longer so the server's own
    /// answer — not a client-side cut — is what the user sees.
    private static let pluginUpdateTimeout: TimeInterval = 400

    /// Which Claude-imported plugins have an update. `force` bypasses the
    /// server's 30-minute marketplace refresh cache.
    func claudePluginUpdates(force: Bool) async throws -> PluginUpdateCheck {
        let path = "/auth/me/claude-plugins/updates" + (force ? "?force=1" : "")
        let (status, data) = try await sendReturningStatus(
            path: path, method: "GET", body: Optional<EmptyBody>.none, timeout: Self.pluginUpdateTimeout)
        try Self.throwUnlessSuccess(status: status, data: data)
        do { return try JSONDecoder().decode(PluginUpdateCheck.self, from: data) }
        catch { throw APIError.decoding(error) }
    }

    /// Same shape as the Claude check (`cli: false`, every row `upstream`);
    /// Codex's update is still the re-import call.
    func codexPluginUpdateCheck() async throws -> PluginUpdateCheck {
        try await get("/auth/me/codex-plugins/updates", authenticated: true)
    }

    /// Update one Claude-imported plugin. The route's 409 / 502 / 404 answers
    /// are outcomes the UI branches on, so they come back as cases, not throws.
    ///
    /// Pre: `acceptCommand` is the sha256 the user was SHOWN with the command,
    /// or nil on a first attempt.
    /// Post: throws only for a transport failure, a validation / auth refusal,
    /// or an unexpected server error (`UPDATE_FAILED`).
    func updateClaudePlugin(name: String, acceptCommand: String?) async throws -> PluginUpdateOutcome {
        struct Req: Encodable { let name: String; let acceptCommand: String? }
        let (status, data) = try await sendReturningStatus(
            path: "/auth/me/claude-plugins/update", method: "POST",
            body: Req(name: name, acceptCommand: acceptCommand), timeout: Self.pluginUpdateTimeout)
        if let outcome = PluginUpdateOutcome.decode(status: status, data: data) { return outcome }
        try Self.throwUnlessSuccess(status: status, data: data)
        // A 2xx that matched no known body is a wire change, not a success.
        throw APIError.decoding(URLError(.cannotParseResponse))
    }

    /// The `send()` error contract for a status read through `sendReturningStatus`.
    private static func throwUnlessSuccess(status: Int, data: Data) throws {
        guard !(200..<300).contains(status) else { return }
        let server = serverError(fromBody: data)
        throw APIError.http(status: status, code: server?.code ?? "UPSTREAM_ERROR",
                            message: server?.message ?? "HTTP \(status)", details: nil)
    }

}

/// `GET /auth/me/{claude,codex}-plugins/updates` from API v60: which imported
/// plugins have an update, and how it was detected.
struct PluginUpdateCheck: Decodable {
    /// False when the `claude` CLI could not answer and the local scan did
    /// (always false for Codex).
    let cli: Bool
    let checkedAt: String
    let updates: [PluginUpdateEntry]
}

/// One row of `PluginUpdateCheck`. `tier` is `"reimport"` (Claude Code already
/// has a newer version than llm-ide's copy) or `"upstream"` (the marketplace
/// offers a newer one).
struct PluginUpdateEntry: Decodable, Hashable, Identifiable {
    let name: String
    let pluginId: String?
    let importedVersion: String?
    let claudeVersion: String?
    let latest: String?
    let tier: String
    /// Legacy field, still sent: what the Codex re-import call needs as `source`.
    let source: String?
    var id: String { name }

    /// The version to show as "the update", most specific first.
    var targetVersion: String? {
        [latest, claudeVersion].compactMap { $0 }.first { !$0.isEmpty }
    }

    /// Same prefix strip as `PluginUpdate.sourcePluginName`, for re-import.
    var sourcePluginName: String {
        for prefix in ["claude-", "codex-"] where name.hasPrefix(prefix) {
            return String(name.dropFirst(prefix.count))
        }
        return name
    }
}

/// What `POST /auth/me/claude-plugins/update` reported. Every case except
/// `.updated` means llm-ide's copy is unchanged.
enum PluginUpdateOutcome: Equatable {
    /// `from == to` means it was already the latest version. `claudeUpdated`
    /// is whether Claude Code's own install changed (false for an offline
    /// re-import, an already-latest answer, or a server that predates it).
    case updated(from: String?, to: String?, trustReset: Bool, claudeUpdated: Bool)
    /// The marketplace declares a command; nothing ran yet. Re-send with
    /// `acceptCommand: sha256` once the user has seen `command`.
    case needsConfirmation(command: String, sha256: String)
    /// Another update is running (one at a time, server-wide).
    case inProgress
    /// A chat turn is running; the reload must not happen mid-turn.
    case busy
    case cliFailed(String)
    /// Claude Code updated, but the re-import failed — the old copy is kept.
    case reimportFailed(String)
    case notFound

    /// The outcome a route answer carries, or nil for an answer that is not
    /// one (the `{error:{…}}` envelope of a 400 / 403 / 500).
    static func decode(status: Int, data: Data) -> PluginUpdateOutcome? {
        struct Body: Decodable {
            let ok: Bool?
            let from: String?
            let to: String?
            let trustReset: Bool?
            let claudeUpdated: Bool?
            let code: String?
            let detail: String?
            let command: String?
            let sha256: String?
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return nil }
        // CLI output can echo a credential; never show it unredacted.
        let detail = SecretRedactor.redact(body.detail ?? "")
        switch (status, body.code) {
        case (200, _) where body.ok == true:
            return .updated(from: body.from, to: body.to, trustReset: body.trustReset ?? false,
                            claudeUpdated: body.claudeUpdated ?? false)
        case (200, "REIMPORT_FAILED"): return .reimportFailed(detail)
        case (409, "NEEDS_CONFIRMATION"):
            guard let command = body.command, let sha = body.sha256 else { return nil }
            return .needsConfirmation(command: command, sha256: sha)
        case (409, "UPDATE_IN_PROGRESS"): return .inProgress
        case (409, "BUSY"): return .busy
        case (502, "CLI_FAILED"): return .cliFailed(detail)
        case (404, "NOT_FOUND"): return .notFound
        default: return nil
        }
    }
}

/// One available update for an imported vendor plugin, as
/// /auth/me/{claude,codex}-plugins/updates reports it. These endpoints existed
/// server-side with no client at all — this is what the Plugins header badge
/// counts and what one-click re-import acts on.
struct PluginUpdate: Decodable, Identifiable, Equatable {
    let name: String
    let importedVersion: String
    let sourceVersion: String
    let source: String
    var id: String { name }

    /// The name to pass back to import: the stored plugin carries the vendor
    /// namespace prefix (`claude-`/`codex-`), the SOURCE plugin does not.
    var sourcePluginName: String {
        for prefix in ["claude-", "codex-"] where name.hasPrefix(prefix) {
            return String(name.dropFirst(prefix.count))
        }
        return name
    }
}

struct PluginUpdatesResponse: Decodable {
    let updates: [PluginUpdate]
}

/// What a vendor rescan found — reported back so the user learns the refresh
/// did something, rather than watching an unchanged list.
struct PluginRefreshResponse: Decodable {
    let installed: Int
    let marketplace: Int
}

struct PluginInstallResponse: Decodable {
    let ok: Bool
    let plugin: InstalledPluginSummary
    /// The provenance the server now holds for this plugin (nil when none, or
    /// from an older server).
    let installSource: PluginInstallSource?
    struct InstalledPluginSummary: Decodable {
        let name: String
        let version: String
        let displayName: String
        let description: String
        let author: String
        let skillCount: Int
        let commandCount: Int
        let subagentCount: Int
        /// True only when an installed copy existed and was overwritten.
        let replaced: Bool
        /// True when the replace cleared hook trust / MCP consents. Nil from an
        /// older server.
        let trustReset: Bool?
        /// Same display-name fallback as `PluginInfo.title`.
        var title: String {
            let trimmed = displayName.trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? name : trimmed
        }
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
    /// "llmide" (own format) or "claude" (a Claude Code / Codex package).
    /// Older servers predate the field — default to the own format.
    let format: String
    /// Vendor components present but never executed (themes, .lsp.json, …).
    let unsupportedComponents: [String]
    /// Vendor components present but inactive until a later phase (hooks, MCP).
    let pendingComponents: [String]
    /// Runnable hook handlers the plugin declares. Zero with `declaresHooks`
    /// false means there is nothing to trust, and the trust toggle stays hidden.
    let hookCount: Int
    /// The package names hook handlers LLM-IDE cannot translate (http, an
    /// unsupported event, declared inline in plugin.json). The Agent engine
    /// loads the whole package and would run what it understands, so these
    /// still need a trust grant even though `hookCount` is zero.
    let declaresHooks: Bool
    /// Which executable components the package declares: "hooks", "monitors"
    /// (background scripts the Agent engine arms unsandboxed), "lsp" (language
    /// servers it starts) and "bin" (executables put on the Bash PATH). All of
    /// them wait for the same trust grant.
    let executableKinds: [String]
    /// Whether the package is a `.claude-plugin` one — the only layout the
    /// Agent SDK reads. Nil from an older server (treated as readable).
    let sdkReadable: Bool?
    /// This user's "Let plugins load natively" preference. Nil from an older
    /// server (treated as on).
    let nativePluginsOn: Bool?
    /// The user trusted an earlier version of this plugin, but it now declares
    /// executable components that grant did not cover (an update added monitors,
    /// a language server or bin/). Nil from an older server.
    let trustOutdated: Bool?
    /// Only the kinds the earlier grant did not cover ("monitors", "sdk" for the
    /// move to native loading, …), so the UI names what is NEW. Nil from an older
    /// server.
    let trustOutdatedKinds: [String]?
    /// Whether the Agent engine can ever load this plugin: the two facts that
    /// decide whether monitors / LSP / bin/ / JS hook modules can run at all.
    var agentEngineCanLoad: Bool { (sdkReadable ?? true) && (nativePluginsOn ?? true) }
    /// What llm-ide will NOT run from this plugin's hooks file (non-command
    /// handler types, unsupported events, refused commands).
    let hookNotes: [String]
    /// Whether THIS user has authorized this plugin's hooks to run shell
    /// commands. Never implied by enabling the plugin.
    let hooksTrusted: Bool
    /// MCP servers the plugin declares; each needs its own consent in the MCP
    /// Plugins section before it connects.
    let mcpServerCount: Int
    /// "claude" / "codex" when a vendor bridge imported the plugin, nil for a
    /// zip install or an older server.
    let origin: String?
    /// The vendor version the import copied (its stamp) — what the user knows
    /// it as; `version` is normalized ("0.0.0" for a sha). Nil when unknown.
    let sourceVersion: String?
    /// Where it was installed from (git / marketplace / zip). Nil for a plugin
    /// installed before provenance was recorded, or from an older server.
    let installSource: PluginInstallSource?
    /// True when this plugin would be handed to the agent engine to load itself
    /// — so its hooks run at full fidelity, and the "not run here" notes below
    /// do not apply. Follows both hook trust and the `nativePlugins` pref.
    let nativeDelivery: Bool
    var id: String { name }
    /// Display name with a fallback to the manifest name — `displayName`
    /// can be missing or whitespace in hand-written manifests. The one
    /// place this fallback lives (rows, menus, install toasts all use it).
    var title: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? name : trimmed
    }
    /// What trusting this plugin lets it run, in the user's words
    /// ("hooks, background monitors"). Empty when it declares nothing beyond
    /// the runnable hooks `hookCount` already counts.
    var executableSummary: String {
        executableKinds.compactMap { kind -> String? in
            switch kind {
            case "hooks": return "hooks"
            case "monitors": return "background monitors"
            case "lsp": return "language servers"
            case "bin": return "bin/ commands"
            default: return nil
            }
        }.joined(separator: ", ")
    }
    /// One-line hook summary shared by the "/" menu row and any other
    /// surface describing this plugin's hooks — one phrasing of the fact,
    /// so two views can't drift apart.
    var hookSummary: String {
        // A plugin whose only executable parts are monitors / a language server
        // has no handlers to count; say what it does have.
        let what = (hookCount == 0 && !executableSummary.isEmpty)
            ? executableSummary
            : "\(hookCount) handler\(hookCount == 1 ? "" : "s")"
        var bits = [what, hooksTrusted ? "trusted" : "not trusted"]
        if !enabled { bits.append("plugin disabled") }
        return bits.joined(separator: " · ")
    }
    // Identity plus the fields a row/detail actually renders differently:
    // toggling the native-plugins pref changes `nativeDelivery` alone, and
    // without it here the view would keep describing the old delivery route.
    static func == (lhs: PluginInfo, rhs: PluginInfo) -> Bool {
        lhs.name == rhs.name && lhs.enabled == rhs.enabled
            && lhs.hooksTrusted == rhs.hooksTrusted && lhs.nativeDelivery == rhs.nativeDelivery
            // A reinstall that changes what the package declares must refresh the
            // label, the warning and the counts the detail view renders.
            && lhs.executableKinds == rhs.executableKinds && lhs.declaresHooks == rhs.declaresHooks
            && lhs.hookCount == rhs.hookCount && lhs.hookNotes == rhs.hookNotes
            && lhs.unsupportedComponents == rhs.unsupportedComponents
            && lhs.mcpServerCount == rhs.mcpServerCount && lhs.version == rhs.version
            && lhs.origin == rhs.origin && lhs.sourceVersion == rhs.sourceVersion
            && lhs.installSource == rhs.installSource
            && lhs.sdkReadable == rhs.sdkReadable && lhs.nativePluginsOn == rhs.nativePluginsOn
            && lhs.trustOutdated == rhs.trustOutdated && lhs.trustOutdatedKinds == rhs.trustOutdatedKinds
            // The rest of what PluginDetailView renders: a reinstall that only adds
            // a .mcp.json or a slash command must not leave the old rows showing.
            && lhs.displayName == rhs.displayName && lhs.description == rhs.description
            && lhs.author == rhs.author && lhs.pendingComponents == rhs.pendingComponents
            && lhs.commands.map(Self.signature) == rhs.commands.map(Self.signature)
            && lhs.subagents.map(Self.signature) == rhs.subagents.map(Self.signature)
    }
    // The command / subagent types are not Equatable; their rendered text is.
    private static func signature(_ command: PluginCommandInfo) -> String {
        "\(command.trigger)|\(command.description)"
    }
    private static func signature(_ subagent: PluginSubagentInfo) -> String {
        "\(subagent.name)|\(subagent.description)|\(subagent.allowedTools.joined(separator: ","))"
    }

    enum CodingKeys: String, CodingKey {
        case name, version, displayName, description, author
        case enabled, skillCount, commands, subagents
        case format, unsupportedComponents, pendingComponents
        case hookCount, declaresHooks, executableKinds, sdkReadable, nativePluginsOn, trustOutdated, trustOutdatedKinds, hookNotes, hooksTrusted, mcpServerCount, nativeDelivery
        case origin, sourceVersion, installSource
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
        self.format      = try c.decodeIfPresent(String.self, forKey: .format) ?? "llmide"
        self.unsupportedComponents = try c.decodeIfPresent([String].self, forKey: .unsupportedComponents) ?? []
        self.pendingComponents     = try c.decodeIfPresent([String].self, forKey: .pendingComponents) ?? []
        self.hookCount      = try c.decodeIfPresent(Int.self, forKey: .hookCount) ?? 0
        self.declaresHooks  = try c.decodeIfPresent(Bool.self, forKey: .declaresHooks) ?? false
        self.executableKinds = try c.decodeIfPresent([String].self, forKey: .executableKinds) ?? []
        self.sdkReadable     = try c.decodeIfPresent(Bool.self, forKey: .sdkReadable)
        self.nativePluginsOn = try c.decodeIfPresent(Bool.self, forKey: .nativePluginsOn)
        self.trustOutdated   = try c.decodeIfPresent(Bool.self, forKey: .trustOutdated)
        self.trustOutdatedKinds = try c.decodeIfPresent([String].self, forKey: .trustOutdatedKinds)
        self.hookNotes      = try c.decodeIfPresent([String].self, forKey: .hookNotes) ?? []
        self.hooksTrusted   = try c.decodeIfPresent(Bool.self, forKey: .hooksTrusted) ?? false
        self.mcpServerCount = try c.decodeIfPresent(Int.self, forKey: .mcpServerCount) ?? 0
        self.nativeDelivery = try c.decodeIfPresent(Bool.self, forKey: .nativeDelivery) ?? false
        self.origin         = try c.decodeIfPresent(String.self, forKey: .origin)
        self.sourceVersion  = try c.decodeIfPresent(String.self, forKey: .sourceVersion)
        // A malformed record must not drop the whole plugin row.
        self.installSource  = (try? c.decodeIfPresent(PluginInstallSource.self, forKey: .installSource)) ?? nil
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
    /// Set from the server's update check (API v60+): whether it reports a
    /// `reimport` tier for this plugin. nil = no check result (older server),
    /// in which case `hasUpdate` keeps the old string comparison.
    var reportedReimport: Bool?
    var id: String { name }

    /// True when re-importing would bring in a newer version. Follows the
    /// server's check when there is one — its comparison is semver-aware and
    /// shared with the Library badge, so the two never disagree.
    var hasUpdate: Bool {
        guard alreadyImported else { return false }
        if let reportedReimport { return reportedReimport }
        guard let iv = importedVersion else { return false }
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

// MARK: - Codex Plugin Bridge DTOs
// Mirrors the Claude Plugin Bridge DTOs above — same shape, different vendor
// (OpenAI Codex CLI's plugin system; see plugins/codex-adapter.mjs).

struct CodexPlugin: Decodable, Identifiable {
    let name: String
    let version: String
    let marketplace: String
    let installPath: String?
    let skillCount: Int
    let commandCount: Int
    var alreadyImported: Bool
    let importedVersion: String?
    var id: String { name }

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

struct CodexMarketplacePlugin: Decodable, Identifiable {
    let name: String
    let marketplace: String
    let description: String
    let hasSkills: Bool
    let hasCommands: Bool
    var installedInCodex: Bool
    var alreadyImported: Bool
    let importedVersion: String?
    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, marketplace, description, hasSkills, hasCommands, installedInCodex, alreadyImported, importedVersion
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.marketplace = try c.decodeIfPresent(String.self, forKey: .marketplace) ?? "unknown"
        self.description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        self.hasSkills = try c.decodeIfPresent(Bool.self, forKey: .hasSkills) ?? false
        self.hasCommands = try c.decodeIfPresent(Bool.self, forKey: .hasCommands) ?? false
        self.installedInCodex = try c.decodeIfPresent(Bool.self, forKey: .installedInCodex) ?? false
        self.alreadyImported = try c.decodeIfPresent(Bool.self, forKey: .alreadyImported) ?? false
        self.importedVersion = try c.decodeIfPresent(String.self, forKey: .importedVersion)
    }
}

struct CodexPluginsListResponse: Decodable {
    let plugins: [CodexPlugin]
}

struct CodexMarketplaceListResponse: Decodable {
    let plugins: [CodexMarketplacePlugin]
}

struct CodexImportResponse: Decodable {
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


extension PluginUpdateEntry {
    /// A pre-v60 row, so a Library on an older server lists updates the same
    /// way. Those servers have no tiers; every row there is a source update.
    init(legacy update: PluginUpdate) {
        self.init(name: update.name, pluginId: nil, importedVersion: update.importedVersion,
                  claudeVersion: update.sourceVersion, latest: update.sourceVersion,
                  tier: "upstream", source: update.source)
    }
}

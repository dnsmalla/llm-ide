import Foundation

// The pure half of Settings → Providers: ONE list of every model connection, however it is stored.
//
// Three stores feed it and none is migrated or deleted here:
//   - the server's provider CATALOG (connections made through the adapter),
//   - the Mac's CUSTOM PROVIDER list (named endpoints, UserDefaults + a vault key each),
//   - the BUILT-IN vault keys (Anthropic, OpenAI, Google, DeepSeek, the shared custom endpoint, Jev, web search).
// `ProviderRowBuilder` folds them into rows, each connection once; `ProviderRow.source` says which store a
// later edit must be routed to. No view, no network, no UserDefaults: everything here is testable as values.

/// What a row talks to. The two connection kinds carry the labels the user sees; the other two are credential
/// rows that are not chat connections (Jev answers decisions, SerpAPI is an optional web-search fallback).
enum ProviderKind: Equatable, Sendable {
    /// Runs through the provider adapter over an OpenAI-style API.
    case openAIAdapter
    /// Runs on the Claude engine over an Anthropic-style API.
    case claudeEngine
    case decisions
    case webSearch

    static let openAILabel = "OpenAI-compatible (adapter)"
    static let claudeLabel = "Claude-compatible (Claude engine)"

    var label: String {
        switch self {
        case .openAIAdapter: return Self.openAILabel
        case .claudeEngine: return Self.claudeLabel
        case .decisions: return "Decision API"
        case .webSearch: return "Web search"
        }
    }
}

/// Whether a key is stored. `unknown` (vault listing not loaded or failed) must read as neither present nor
/// missing, so a backend that is down never paints every row "key missing".
enum ProviderKeyStatus: Equatable, Sendable {
    case stored, missing, notNeeded, unknown
}

struct ProviderRow: Identifiable, Equatable {
    enum Source: Equatable {
        /// A catalog connection: lives on the server (`/kb/providers/catalog/*`).
        case catalog(connectionId: String, catalogId: String)
        /// A built-in vault key row (`ProviderCatalog.Entry.id`).
        case builtIn(String)
        /// A named custom provider (`CustomProvider.id`): Mac list + vault key.
        case custom(String)
    }

    let id: String
    let source: Source
    let name: String
    /// Base URL when the row has one, else nil.
    let baseURL: String?
    /// One muted line under the name (the URL, a description or the built-in's hint).
    let detail: String
    let kind: ProviderKind
    let keyStatus: ProviderKeyStatus
    let enabled: Bool
    /// Set when a one-click "Move to catalog" is offered: the legacy id the SERVER copies the key from
    /// (`copyKeyFrom`). Nil when the row is already a catalog connection or cannot move.
    let moveSource: String?
    /// A catalog row that also has an older key stored under its legacy name. Kept, never deleted, so the
    /// row says so instead of showing the provider twice.
    let alsoLegacyKey: Bool

    var isCatalog: Bool { if case .catalog = source { return true } else { return false } }
    var isCustom: Bool { if case .custom = source { return true } else { return false } }
    var builtInId: String? { if case .builtIn(let id) = source { return id } else { return nil } }

    /// Enable/disable exists for the two stores that have an enabled flag.
    var canToggle: Bool { isCatalog || isCustom }
    /// Remove (disconnect / delete) exists for catalog connections and custom providers. A built-in only
    /// has its key cleared (`canClearKey`): it has no connection to remove.
    var canRemove: Bool { isCatalog || isCustom }
    var canClearKey: Bool { builtInId != nil && keyStatus == .stored }
    /// Only the custom list holds details (URLs, models, description) the user edits here.
    var canEditDetails: Bool { isCustom }
}

/// The everything-in-one-place input, gathered by the view-model from the three stores.
struct ProviderListInput {
    var catalogProviders: [LlmIdeAPIClient.CatalogProvider] = []
    /// False until the catalog has loaded (or when it failed): without it nothing can be deduped, so no
    /// "Move to catalog" is offered (it could create a second connection for something already connected).
    var catalogKnown = false
    var custom: [CustomProvider] = []
    var builtIns: [ProviderCatalog.Entry] = []
    /// Vault key names that hold a value; nil when the listing has not loaded or failed.
    var configuredKeys: Set<String>?
    /// The shared custom endpoint's last saved base URL (the vault is write-only).
    var sharedBaseURL = ""
    /// "Check CLI" verdicts by provider id, so a CLI-only OpenAI/Google row can stay visible.
    var cliReady: [String: Bool] = [:]
}

enum ProviderRowBuilder {
    /// Normalised endpoint for comparing two base URLs: scheme and host lowercased, no query or fragment,
    /// no trailing slash. Empty for anything that is not a URL.
    static func normalizedURL(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var c = URLComponents(string: trimmed), let host = c.host, !host.isEmpty else { return "" }
        c.scheme = c.scheme?.lowercased()
        c.host = host.lowercased()
        c.query = nil
        c.fragment = nil
        var path = c.path
        while path.hasSuffix("/") { path.removeLast() }
        c.path = path
        return c.string ?? ""
    }

    /// The legacy provider ids whose stored keys the catalog migration carries: the catalog entry each maps to.
    static let builtInCatalogIds: Set<String> = ["openai", "google", "deepseek"]

    /// Same rule the server uses to name a migrated custom provider's connection (`slugFor`), so a copy made
    /// here and a copy made by the one-time migration land on the same connection.
    static func slug(forCustomId id: String) -> String {
        let alnum = id.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        return String("m\(alnum.prefix(10))".prefix(24))
    }

    static func kind(of provider: CustomProvider) -> ProviderKind {
        // A provider with an Anthropic-style door runs on the Claude engine. One that says it is not
        // OpenAI-compatible and has no second door is an Anthropic-format endpoint too.
        if provider.canRunAgentEngine || !provider.isOpenAICompatible { return .claudeEngine }
        return .openAIAdapter
    }

    static func rows(_ input: ProviderListInput) -> [ProviderRow] {
        let connections = input.catalogProviders.flatMap(\.connections)
        let configured = input.configuredKeys
        func keyStatus(_ vaultKey: String, optional: Bool = false) -> ProviderKeyStatus {
            guard let configured else { return .unknown }
            if configured.contains(vaultKey) { return .stored }
            return optional ? .notNeeded : .missing
        }
        func stored(_ vaultKey: String) -> Bool { configured?.contains(vaultKey) == true }

        let catalogURLs = Set(connections.map { normalizedURL($0.baseURL) }.filter { !$0.isEmpty })
        let catalogIds = Set(connections.map(\.catalogId))

        var out: [ProviderRow] = []

        // 1. Catalog connections: always shown, once each.
        for c in connections {
            let legacyId = c.catalogId
            let legacyStored: Bool = {
                if builtInCatalogIds.contains(legacyId),
                   let entry = input.builtIns.first(where: { $0.id == legacyId }) { return stored(entry.vaultKey) }
                return input.custom.contains { cp in
                    cp.isOpenAICompatible && !cp.canRunAgentEngine && stored(cp.apiKey)
                        && normalizedURL(cp.baseURL) == normalizedURL(c.baseURL)
                }
            }()
            out.append(ProviderRow(
                id: "catalog:\(c.id)", source: .catalog(connectionId: c.id, catalogId: c.catalogId),
                name: c.name, baseURL: c.baseURL, detail: c.baseURL, kind: .openAIAdapter,
                keyStatus: c.hasKey ? .stored : .missing, enabled: c.enabled, moveSource: nil,
                alsoLegacyKey: legacyStored))
        }

        // 2. Custom providers. One that is OpenAI-only and points where a catalog connection already points
        //    is the same connection shown twice: hidden (still stored). A provider with a Claude-style door
        //    stays, since the catalog adapter cannot run it on the Claude engine.
        for cp in input.custom {
            let kind = kind(of: cp)
            let url = normalizedURL(cp.baseURL)
            let inCatalog = !url.isEmpty && catalogURLs.contains(url)
            if kind == .openAIAdapter && inCatalog { continue }
            let canMove = input.catalogKnown && cp.isOpenAICompatible && !inCatalog && !url.isEmpty
            out.append(ProviderRow(
                id: "custom:\(cp.id)", source: .custom(cp.id), name: cp.name.isEmpty ? cp.baseURL : cp.name,
                baseURL: cp.baseURL, detail: cp.description.isEmpty ? cp.baseURL : cp.description, kind: kind,
                keyStatus: keyStatus(cp.apiKey, optional: EndpointSecurity.isLoopbackURL(cp.baseURL)),
                enabled: cp.isEnabled, moveSource: canMove ? "custom:\(cp.id)" : nil, alsoLegacyKey: false))
        }

        // 3. Built-in credential rows.
        let shared = input.sharedBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        for e in input.builtIns {
            switch e.id {
            case ClaudeCLI.provider:
                out.append(builtIn(e, kind: .claudeEngine, status: keyStatus(e.vaultKey, optional: true), move: nil,
                                   baseURL: nil))
            case "openai", "google", "deepseek":
                // The catalog connection replaces the legacy row. Without one, the row stays while it has a key
                // or a CLI subscription mode (codex / gemini) the user may rely on.
                if catalogIds.contains(e.id) { continue }
                let hasKey = stored(e.vaultKey)
                let cliMode = !(e.tool?.cliExecutable ?? "").isEmpty
                guard hasKey || cliMode || configured == nil else { continue }
                out.append(builtIn(e, kind: .openAIAdapter, status: keyStatus(e.vaultKey, optional: cliMode),
                                   move: (input.catalogKnown && hasKey) ? e.id : nil, baseURL: nil))
            case "custom":
                // The shared OpenAI-compatible endpoint: shown while it has a key or a saved base URL, and
                // not at all once the catalog connects the same address.
                let url = normalizedURL(shared)
                if !url.isEmpty && catalogURLs.contains(url) { continue }
                let hasKey = stored(e.vaultKey)
                guard hasKey || !shared.isEmpty || configured == nil else { continue }
                out.append(builtIn(e, kind: .openAIAdapter, status: keyStatus(e.vaultKey, optional: false),
                                   move: (input.catalogKnown && hasKey && !url.isEmpty) ? "custom" : nil,
                                   baseURL: shared.isEmpty ? nil : shared))
            case ProviderCatalog.jevId:
                out.append(builtIn(e, kind: .decisions, status: keyStatus(e.vaultKey), move: nil, baseURL: nil))
            default:
                out.append(builtIn(e, kind: .webSearch, status: keyStatus(e.vaultKey, optional: true), move: nil,
                                   baseURL: nil))
            }
        }
        return out
    }

    private static func builtIn(_ e: ProviderCatalog.Entry, kind: ProviderKind, status: ProviderKeyStatus,
                                move: String?, baseURL: String?) -> ProviderRow {
        ProviderRow(id: "builtin:\(e.id)", source: .builtIn(e.id), name: e.label, baseURL: baseURL,
                    detail: baseURL ?? e.hint, kind: kind, keyStatus: status, enabled: true, moveSource: move,
                    alsoLegacyKey: false)
    }

    // MARK: - Requests the rows turn into

    /// The connect request that re-saves an existing catalog connection with a change. The server rebuilds the
    /// connection from the request, so everything that defines it is sent again (URL and slug for a generic
    /// endpoint, the private-network opt-in, the name); a key only when `apiKey` is given.
    static func request(updating c: LlmIdeAPIClient.CatalogConnection, in entry: LlmIdeAPIClient.CatalogProvider?,
                        apiKey: String? = nil, enabled: Bool? = nil) -> LlmIdeAPIClient.CatalogConnectRequest {
        let generic = entry?.customBaseURL == true
        var slug: String?
        let prefix = "cat-\(c.catalogId)-"
        if generic, c.id.hasPrefix(prefix) { slug = String(c.id.dropFirst(prefix.count)) }
        let needsURL = generic || entry?.local == true
        return LlmIdeAPIClient.CatalogConnectRequest(
            catalogId: c.catalogId, apiKey: apiKey, baseURL: needsURL ? c.baseURL : nil, slug: slug, name: c.name,
            allowPrivate: (generic || entry?.local == true) ? c.allowPrivate : nil, enabled: enabled ?? c.enabled)
    }

    /// The connect request behind "Move to catalog". The key is never in it: the server copies it from
    /// `copyKeyFrom`, and the legacy entry stays where it is.
    static func moveRequest(for row: ProviderRow, custom: [CustomProvider]) -> LlmIdeAPIClient.CatalogConnectRequest? {
        guard let from = row.moveSource else { return nil }
        switch row.source {
        case .catalog:
            return nil
        case .builtIn(let id):
            if id == "custom" {
                guard let url = row.baseURL else { return nil }
                return .init(catalogId: "openai-compatible", baseURL: url, slug: "legacy", name: "Custom endpoint",
                             allowPrivate: EndpointSecurity.isLoopbackURL(url) ? true : nil, copyKeyFrom: from)
            }
            return .init(catalogId: id, copyKeyFrom: from)
        case .custom(let id):
            guard let cp = custom.first(where: { $0.id == id }) else { return nil }
            return .init(catalogId: "openai-compatible", baseURL: cp.baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                         slug: slug(forCustomId: id), name: cp.name.isEmpty ? nil : cp.name,
                         allowPrivate: EndpointSecurity.isLoopbackURL(cp.baseURL) ? true : nil, copyKeyFrom: from)
        }
    }

    /// Models shown for one connection before "Show all": a very long list must not bury the page.
    static let modelPreviewLimit = 30

    static func visibleModels(_ models: [LlmIdeAPIClient.CatalogModel], showAll: Bool) -> [LlmIdeAPIClient.CatalogModel] {
        showAll || models.count <= modelPreviewLimit ? models : Array(models.prefix(modelPreviewLimit))
    }
}

/// Words the Providers section uses, in one place so a test can pin them.
enum ProvidersText {
    static let title = "Providers"
    static let intro = "Every model connection, shown once. Add a provider from the catalog or by its URL; a key is stored encrypted on this machine's backend and is never shown again."
    static let movedNote = "Copied to the catalog. The old entry and its key are kept."
}

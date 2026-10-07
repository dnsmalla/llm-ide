import Foundation

// Model-provider credential verification (see extension/agents/providers.mjs).
// Keys are stored via the generic `setSecret` (vault key `<provider>.apiKey`);
// these helpers verify a key works and list which providers are configured.
extension LlmIdeAPIClient {
    struct ProviderVerifyResult: Decodable {
        let ok: Bool
        let detail: String?
    }

    /// Verify a provider credential. `mode` is "key" (live 1-token probe of
    /// `apiKey`, or the stored key when `apiKey` is nil) or "cli" (checks the
    /// provider's CLI binary is installed for subscription mode).
    func verifyProvider(_ provider: String, mode: String, apiKey: String?,
                        baseUrl: String? = nil) async throws -> ProviderVerifyResult {
        struct Req: Encodable {
            let provider: String
            let mode: String
            let apiKey: String?
            let baseUrl: String?
        }
        return try await post("/kb/providers/verify",
                              body: Req(provider: provider, mode: mode, apiKey: apiKey, baseUrl: baseUrl),
                              authenticated: true)
    }

    /// Live chat models for a provider. For Claude the backend asks the Agent
    /// SDK for the account's own list (works with a `claude login` and no API
    /// key) and sends display names in `entries`; other providers return ids
    /// from their models endpoint, filtered server-side, shown as-is. Returns
    /// [] when nothing could be listed, so callers keep a fallback list
    /// rather than an empty UI.
    func listProviderModels(_ provider: String) async throws -> [AIModel] {
        struct Req: Encodable { let provider: String }
        struct Resp: Decodable { let models: [String]; let entries: [ProviderModelEntry]? }
        let r: Resp = try await post("/kb/providers/models",
                                     body: Req(provider: provider),
                                     authenticated: true)
        if let entries = r.entries, !entries.isEmpty {
            return entries.map {
                AIModel(id: $0.id,
                        displayName: ($0.displayName?.isEmpty == false) ? $0.displayName! : $0.id,
                        effortLevels: $0.effortLevels)
            }
        }
        return r.models.map { AIModel(id: $0, displayName: $0) }
    }

    /// Vault keys the user currently has set (names only — values never leave
    /// the server). Used to show a "configured" badge per provider.
    func configuredSecretKeys() async throws -> Set<String> {
        struct Row: Decodable { let key: String }
        struct Resp: Decodable { let secrets: [Row] }
        let r: Resp = try await get("/auth/me/secrets", authenticated: true)
        return Set(r.secrets.map(\.key))
    }

    /// Push the locally-persisted custom providers into the backend's
    /// per-user registry (POST /kb/custom-providers). The registry is the only
    /// place that maps a `custom:<id>` provider id → baseURL + vault key; the
    /// server persists it, and this is re-sent whenever the Custom Providers
    /// section appears and after every add/edit/delete/toggle.
    ///
    /// Authenticated: the route is behind the global `authenticate` middleware,
    /// so an unauthenticated POST 401s and the provider silently never
    /// resolves at code-assist time. Call sites fire-and-forget (best-effort).
    ///
    /// - Parameter timeout: per-request timeout; nil keeps the session's
    ///   default. The tier-routing refresh chain passes a short one so a
    ///   wedged backend cannot stall every later refresh.
    func syncCustomProviders(_ providers: [CustomProvider], timeout: TimeInterval? = nil) async throws {
        struct Req: Encodable { let providers: [CustomProvider] }
        struct Ack: Decodable { let success: Bool?; let count: Int? }
        if let timeout {
            let _: Ack = try await post("/kb/custom-providers", body: Req(providers: providers),
                                        authenticated: true, timeout: timeout)
        } else {
            let _: Ack = try await post("/kb/custom-providers", body: Req(providers: providers),
                                        authenticated: true)
        }
    }

    /// Mirror the tier-routing table into the backend (POST /kb/routing-tiers),
    /// which replaces this user's table there. The server routes subagents, the
    /// pipeline and internal helpers by it; the Mac routes its own surfaces from
    /// the local copy. Callers re-send on every change and on Settings appear,
    /// and treat a failure as non-fatal — an unsynced table only means the
    /// server keeps using its defaults.
    ///
    /// - Returns: the entries the server dropped as invalid (API v67+; empty
    ///   from an older server, which does not report them).
    @discardableResult
    func syncTierRouting(_ config: TierRoutingConfig) async throws -> [TierRoutingDropped] {
        struct Ack: Decodable { let success: Bool?; let dropped: [TierRoutingDropped]? }
        // Short timeout: this runs on the serialized refresh chain, where one
        // wedged request would hold up every later refresh.
        let ack: Ack = try await post("/kb/routing-tiers", body: config, authenticated: true,
                                      timeout: TierRouting.refreshRequestTimeout)
        return ack.dropped ?? []
    }

    /// The server's per-tier status (GET /kb/routing-tiers, API v67+): whether
    /// its resolver can run each tier (vault keys, installed CLIs, synced
    /// custom providers) and whether the Agent engine can, keyed by
    /// `RoutingTier.rawValue`; plus per-role status (`featureStatus`, v69+,
    /// nil from an older server), keyed by `RoutedFeature.rawValue`.
    func fetchTierRoutingStatus() async throws
        -> (status: [String: TierServerStatus], featureStatus: [String: TierFeatureServerStatus]?) {
        struct Response: Decodable {
            let status: [String: TierServerStatus]?
            let featureStatus: [String: TierFeatureServerStatus]?
        }
        let response: Response = try await get("/kb/routing-tiers", authenticated: true,
                                               timeout: TierRouting.refreshRequestTimeout)
        return (response.status ?? [:], response.featureStatus)
    }
}

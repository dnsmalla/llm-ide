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
        struct Entry: Decodable { let id: String; let displayName: String? }
        struct Resp: Decodable { let models: [String]; let entries: [Entry]? }
        let r: Resp = try await post("/kb/providers/models",
                                     body: Req(provider: provider),
                                     authenticated: true)
        if let entries = r.entries, !entries.isEmpty {
            return entries.map { AIModel(id: $0.id, displayName: ($0.displayName?.isEmpty == false) ? $0.displayName! : $0.id) }
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
    func syncCustomProviders(_ providers: [CustomProvider]) async throws {
        struct Req: Encodable { let providers: [CustomProvider] }
        struct Ack: Decodable { let success: Bool?; let count: Int? }
        let _: Ack = try await post("/kb/custom-providers",
                                    body: Req(providers: providers),
                                    authenticated: true)
    }
}

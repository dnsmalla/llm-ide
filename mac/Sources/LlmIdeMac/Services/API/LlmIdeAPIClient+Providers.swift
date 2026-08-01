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
    func verifyProvider(_ provider: String, mode: String, apiKey: String?) async throws -> ProviderVerifyResult {
        struct Req: Encodable {
            let provider: String
            let mode: String
            let apiKey: String?
        }
        return try await post("/kb/providers/verify",
                              body: Req(provider: provider, mode: mode, apiKey: apiKey),
                              authenticated: true)
    }

    /// Live chat-model ids for a provider (from its models endpoint, filtered
    /// server-side). Returns [] when no key is configured or the fetch fails,
    /// so callers fall back to a built-in static list rather than an empty UI.
    func listProviderModels(_ provider: String) async throws -> [String] {
        struct Req: Encodable { let provider: String }
        struct Resp: Decodable { let models: [String] }
        let r: Resp = try await post("/kb/providers/models",
                                     body: Req(provider: provider),
                                     authenticated: true)
        return r.models
    }

    /// Vault keys the user currently has set (names only — values never leave
    /// the server). Used to show a "configured" badge per provider.
    func configuredSecretKeys() async throws -> Set<String> {
        struct Row: Decodable { let key: String }
        struct Resp: Decodable { let secrets: [Row] }
        let r: Resp = try await get("/auth/me/secrets", authenticated: true)
        return Set(r.secrets.map(\.key))
    }

    /// Push the locally-persisted custom providers into the backend's in-memory
    /// registry (POST /kb/custom-providers). The registry is the only place
    /// that maps a `custom:<id>` provider id → baseURL + vault key, and it is
    /// lost on server restart — so this is re-sent whenever the Custom
    /// Providers section appears and after every add/edit/delete/toggle.
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

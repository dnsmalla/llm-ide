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

    /// Vault keys the user currently has set (names only — values never leave
    /// the server). Used to show a "configured" badge per provider.
    func configuredSecretKeys() async throws -> Set<String> {
        struct Row: Decodable { let key: String }
        struct Resp: Decodable { let secrets: [Row] }
        let r: Resp = try await get("/auth/me/secrets", authenticated: true)
        return Set(r.secrets.map(\.key))
    }
}

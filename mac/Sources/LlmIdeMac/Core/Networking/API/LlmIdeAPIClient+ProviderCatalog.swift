import Foundation

// MARK: - Provider catalog (connections, capability flags, switches)
//
// Server: extension/routes/provider-catalog.mjs, shapes in
// schema/http/provider-catalog.schema.json (server API v90). Always on. A key is
// sent to `connect` once and goes to the per-user vault; it is never returned,
// so nothing here can show or log one. A connection dispatches as the provider
// id `custom:<id>` (`ProviderConnection.provider`).

extension LlmIdeAPIClient {

    /// One connection the user made to a catalog provider.
    public struct CatalogConnection: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let provider: String
        public let catalogId: String
        public let name: String
        public let baseURL: String
        public let allowPrivate: Bool
        public let enabled: Bool
        public let hasKey: Bool
    }

    /// One built-in catalog entry with the caller's connections to it.
    public struct CatalogProvider: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let baseURL: String
        public let keyRequired: Bool
        public let local: Bool
        public let customBaseURL: Bool
        public let allowPrivate: Bool
        public let docsUrl: String
        public let notes: String
        public let connections: [CatalogConnection]
    }

    /// One slot in the user's ordered fallback list. `model` nil = the first
    /// tool-capable catalog model of that provider.
    public struct CatalogFallbackEntry: Codable, Equatable, Hashable, Sendable {
        public let provider: String
        public let model: String?

        public init(provider: String, model: String? = nil) {
            self.provider = provider
            self.model = model
        }
    }

    /// The two opt-in switches and the user's own ordering and overrides.
    public struct CatalogSettings: Codable, Equatable, Sendable {
        public var toolsEnabled: Bool
        public var fallbackEnabled: Bool
        public var fallbackOrder: [CatalogFallbackEntry]
        /// "<connection id>/<model id>" -> the user's own tools yes/no.
        public var toolOverrides: [String: Bool]
        /// false (default): fetch-url and web-search ask for approval in a provider turn.
        public var egressAutoApprove: Bool

        public init(toolsEnabled: Bool = false, fallbackEnabled: Bool = false,
                    fallbackOrder: [CatalogFallbackEntry] = [], toolOverrides: [String: Bool] = [:],
                    egressAutoApprove: Bool = false) {
            self.egressAutoApprove = egressAutoApprove
            self.toolsEnabled = toolsEnabled
            self.fallbackEnabled = fallbackEnabled
            self.fallbackOrder = fallbackOrder
            self.toolOverrides = toolOverrides
        }
    }

    public struct CatalogResponse: Codable, Equatable, Sendable {
        public let providers: [CatalogProvider]
        public let settings: CatalogSettings
    }

    /// A model with its capability flags. `toolsSource` says where the flag came
    /// from (catalog, provider, inferred, override, unknown); unknown counts as no tools.
    public struct CatalogModel: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let toolsSupported: Bool
        public let toolsSource: String
        public let streaming: Bool
        public let contextWindow: Int?
    }

    public struct CatalogModelList: Codable, Equatable, Sendable {
        public let models: [CatalogModel]
        /// "live", "cache" or "static" (the catalog's own table).
        public let source: String
        public let detail: String?
    }

    public struct CatalogTestResult: Codable, Equatable, Sendable {
        public let ok: Bool
        public let detail: String
        public let modelCount: Int?
    }

    public struct CatalogAck: Codable, Equatable, Sendable { public let ok: Bool; public let removed: Bool }
    public struct CatalogConnectAck: Codable, Equatable, Sendable { public let ok: Bool; public let connection: CatalogConnection }

    /// GET /kb/providers/catalog.
    func fetchProviderCatalog() async throws -> CatalogResponse {
        try await get("/kb/providers/catalog", authenticated: true)
    }

    /// POST /kb/providers/catalog/connect. `apiKey` nil on a reconnect keeps the stored key.
    func connectCatalogProvider(catalogId: String, apiKey: String?, baseURL: String? = nil,
                                slug: String? = nil, name: String? = nil,
                                allowPrivate: Bool? = nil) async throws -> CatalogConnection {
        struct Req: Encodable {
            let catalogId: String
            let apiKey: String?
            let baseURL: String?
            let slug: String?
            let name: String?
            let allowPrivate: Bool?
        }
        let ack: CatalogConnectAck = try await post(
            "/kb/providers/catalog/connect",
            body: Req(catalogId: catalogId, apiKey: apiKey, baseURL: baseURL, slug: slug, name: name,
                      allowPrivate: allowPrivate),
            authenticated: true)
        return ack.connection
    }

    /// POST /kb/providers/catalog/disconnect: removes the connection and its stored key.
    @discardableResult
    func disconnectCatalogProvider(id: String) async throws -> Bool {
        struct Req: Encodable { let id: String }
        let ack: CatalogAck = try await post("/kb/providers/catalog/disconnect", body: Req(id: id), authenticated: true)
        return ack.removed
    }

    /// POST /kb/providers/catalog/test: a free GET /models against the provider.
    func testCatalogProvider(id: String) async throws -> CatalogTestResult {
        struct Req: Encodable { let id: String }
        return try await post("/kb/providers/catalog/test", body: Req(id: id), authenticated: true)
    }

    /// POST /kb/providers/catalog/models: the provider's chat models with capability flags.
    func fetchCatalogModels(id: String, refresh: Bool = false) async throws -> CatalogModelList {
        struct Req: Encodable { let id: String; let refresh: Bool }
        return try await post("/kb/providers/catalog/models", body: Req(id: id, refresh: refresh), authenticated: true)
    }

    /// GET /kb/providers/settings.
    func fetchProviderCatalogSettings() async throws -> CatalogSettings {
        try await get("/kb/providers/settings", authenticated: true)
    }

    /// PUT /kb/providers/settings: answers the settings the server kept.
    func saveProviderCatalogSettings(_ settings: CatalogSettings) async throws -> CatalogSettings {
        try await put("/kb/providers/settings", body: settings, authenticated: true)
    }
}

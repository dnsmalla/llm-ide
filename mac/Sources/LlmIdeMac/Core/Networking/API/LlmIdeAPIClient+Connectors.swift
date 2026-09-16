import Foundation

/// One connector-catalog entry — the Library's "Add from catalog…" list and
/// the Settings → Connections selection both read this shape. Mirrors
/// `extension/connectors/connector-catalog.mjs`.
struct ConnectorCatalogEntry: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let description: String
    let icon: String          // SF Symbol name
    let authKind: String      // google-oauth | slack-oauth | box-ccg | miro-oauth
    let docsUrl: String
    /// False while the fetch→folder→llm-doc pipeline for this connector does
    /// not exist yet (phase 1: gdrive/gcal/miro) — render a placeholder card.
    let pipelineReady: Bool
    /// Only `/auth/me/connectors/catalog` sets it; the selected-list omits it.
    var selected: Bool = false

    enum CodingKeys: String, CodingKey {
        case id, name, description, icon, authKind, docsUrl, pipelineReady, selected
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        self.icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? "puzzlepiece.extension"
        self.authKind = try c.decode(String.self, forKey: .authKind)
        self.docsUrl = try c.decodeIfPresent(String.self, forKey: .docsUrl) ?? ""
        self.pipelineReady = try c.decodeIfPresent(Bool.self, forKey: .pipelineReady) ?? false
        self.selected = try c.decodeIfPresent(Bool.self, forKey: .selected) ?? false
    }
}

// Connector catalog + per-user selection — GET/POST/DELETE
// /auth/me/connectors/*. Selection drives which connector cards the Library
// and the Settings Connections section show; Meeting and Email are fixed
// defaults and are NOT part of this catalog.
extension LlmIdeAPIClient {

    private struct ConnectorListResponse: Decodable { let connectors: [ConnectorCatalogEntry] }
    private struct ConnectorCatalogResponse: Decodable { let catalog: [ConnectorCatalogEntry] }
    private struct ConnectorAck: Decodable { let ok: Bool; let id: String }

    /// This user's selected connectors (box + slack are pre-selected server-side).
    func listConnectors() async throws -> [ConnectorCatalogEntry] {
        let resp: ConnectorListResponse = try await get("/auth/me/connectors", authenticated: true)
        return resp.connectors
    }

    /// The whole curated catalog, each entry flagged `selected` for this user.
    func fetchConnectorCatalog() async throws -> [ConnectorCatalogEntry] {
        let resp: ConnectorCatalogResponse = try await get("/auth/me/connectors/catalog", authenticated: true)
        return resp.catalog
    }

    /// Select a connector. Idempotent; 400s on an id the catalog does not know.
    func addConnector(id: String) async throws {
        struct Req: Encodable { let id: String }
        let _: ConnectorAck = try await post("/auth/me/connectors/add", body: Req(id: id), authenticated: true)
    }

    /// Deselect a connector. Never deletes ingested data — visibility only.
    func removeConnector(id: String) async throws {
        let _: ConnectorAck = try await delete("/auth/me/connectors/\(percentEncoded(id))", authenticated: true)
    }
}

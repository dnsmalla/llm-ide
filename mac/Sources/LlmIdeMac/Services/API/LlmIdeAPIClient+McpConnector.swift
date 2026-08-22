import Foundation

// Generic MCP-backed connector endpoints. Unlike +Slack / +Email these take
// the PATH as a parameter: every MCP connector shares one route family
// (`/kb/mcp-connector/{test,fetch,seen,classify}`) and the paths come from its
// manifest, which is the point of a manifest engine.
extension LlmIdeAPIClient {

    /// One item the server already mapped and deduped. `id` is the stable
    /// dedup key (`<connector>:<parent>:<item>`, plus `#n` for a chunked item)
    /// and must be echoed back to `/seen` after the raw file is written.
    ///
    /// Note that `id` arrives as a SIBLING of `fields`, not inside it — the
    /// server deliberately omits `ItemId` from the field map. Anything that
    /// needs the id downstream has to carry it across itself; see
    /// `McpConnectorAdapter`, which injects it into `fields["ItemId"]`.
    struct McpFetchedItem: Decodable {
        let id: String
        let fields: [String: String]
        let body: String
    }

    struct McpSkipped: Decodable { let overCap: Int }

    struct McpFetchResult: Decodable {
        let items: [McpFetchedItem]
        let drained: Bool
        let skipped: McpSkipped
        /// Per-parent non-fatal failures. Defaulted: a fetch that imported real
        /// items must not be discarded because this array was absent.
        let failures: [String]

        enum CodingKeys: String, CodingKey { case items, drained, skipped, failures }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.items    = try c.decode([McpFetchedItem].self, forKey: .items)
            self.drained  = try c.decodeIfPresent(Bool.self, forKey: .drained) ?? true
            self.skipped  = try c.decodeIfPresent(McpSkipped.self, forKey: .skipped) ?? McpSkipped(overCap: 0)
            self.failures = try c.decodeIfPresent([String].self, forKey: .failures) ?? []
        }
    }

    func fetchMcpConnector(path: String, id: String, limit: Int) async throws -> McpFetchResult {
        struct Req: Encodable { let id: String; let limit: Int }
        return try await post(path, body: Req(id: id, limit: limit), authenticated: true)
    }

    func markMcpConnectorSeen(path: String, id: String, itemIds: [String]) async throws {
        struct Req: Encodable { let id: String; let itemIds: [String] }
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await post(path, body: Req(id: id, itemIds: itemIds), authenticated: true)
    }
}

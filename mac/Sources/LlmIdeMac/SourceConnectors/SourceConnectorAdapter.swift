import Foundation

/// One item fetched by an adapter, as a field-value dict + the text body.
struct SourceConnectorFetchedItem {
    let fields: [String: String]
    let body: String
}

/// What an adapter's `fetch` returns: the items, whether the source fully
/// drained (advance the high-water), per-fetch cap overflow, and non-fatal
/// failures accumulated per source/channel.
struct SourceConnectorFetchBatch {
    let items: [SourceConnectorFetchedItem]
    let drained: Bool
    let overCap: Int
    let failures: [String]
}

/// Opaque field map the engine POSTs to the manifest's `classify` endpoint.
struct ClassifyRequest: Encodable {
    let body: [String: String]
}

/// `/kb/.../classify` response (twin of `LlmIdeAPIClient.EmailClassification`).
struct SourceConnectorClassification: Decodable, Equatable {
    let category: String
    let noteWorthy: Bool
    let summary: String
    let todos: [Todo]
    struct Todo: Decodable, Equatable {
        let title: String
        let detail: String
        let due: String?
        let priority: String
    }
}

/// Owns ONLY the wire-shape mechanics for one source. Everything else
/// (raw storage, dedup, the generation loop, note writing, high-water
/// accounting) lives in the engine.
@MainActor
protocol SourceConnectorAdapter {
    func fetch(_ ctx: SourceContext) async throws -> SourceConnectorFetchBatch
    func markSeen(_ ctx: SourceContext, batch: SourceConnectorFetchBatch, drained: Bool) async throws
    func classifyRequest(from item: RawInboxItem) -> ClassifyRequest
}

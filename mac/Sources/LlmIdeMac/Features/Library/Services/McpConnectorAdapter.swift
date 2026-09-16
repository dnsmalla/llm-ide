import Foundation

/// The two calls an MCP connector adapter makes. A protocol rather than a
/// direct `LlmIdeAPIClient` dependency because there is no `URLProtocol`
/// stubbing anywhere in this test target — the codebase's established seam is
/// injection (`SourceContext.classify`, `SlackSource.ingest`), and this keeps
/// the adapter's tests offline and instant.
@MainActor
protocol McpConnectorTransport {
    func fetch(path: String, id: String, limit: Int) async throws -> LlmIdeAPIClient.McpFetchResult
    func markSeen(path: String, id: String, itemIds: [String]) async throws
}

/// The live transport: a thin pass-through to the API client.
@MainActor
struct LiveMcpConnectorTransport: McpConnectorTransport {
    let api: LlmIdeAPIClient
    func fetch(path: String, id: String, limit: Int) async throws -> LlmIdeAPIClient.McpFetchResult {
        try await api.fetchMcpConnector(path: path, id: id, limit: limit)
    }
    func markSeen(path: String, id: String, itemIds: [String]) async throws {
        try await api.markMcpConnectorSeen(path: path, id: id, itemIds: itemIds)
    }
}

/// ONE adapter for every MCP-backed connector — Miro today, Google Drive and
/// Calendar in phase 3 — parameterised by connector id and the manifest's
/// endpoint paths. Not one adapter per connector: there is nothing per
/// connector left to write.
///
/// It is this thin on purpose. The server already opened the MCP session,
/// enumerated the source, called the tools, mapped each result to
/// `{ id, fields, body }`, dropped everything already in the seen ledger and
/// chunked anything oversized (`connectors/mcp-client.mjs`). Everything the
/// Mac would otherwise have to know about a provider lives in a descriptor
/// there, which is the entire argument for going through MCP.
///
/// The one thing this class genuinely owns: `SourceConnectorFetchedItem` has
/// no id field (`SourceConnectorAdapter.swift`) and the server sends the dedup
/// key as a SIBLING of `fields`, never inside it. So the key has to ride in
/// `fields["ItemId"]` to survive the fetch → InboxStore → markSeen round trip.
/// The manifests map it to a raw header, so the injection also feeds the
/// note's frontmatter — skip it and that header writes empty AND every sweep
/// re-imports the whole board.
@MainActor
final class McpConnectorAdapter: SourceConnectorAdapter {
    /// The `fields` key the server's sibling `id` is injected into. Matches the
    /// `"ItemId": "$ItemId"` entry in every MCP connector manifest.
    static let itemIdField = "ItemId"

    private let connectorId: String
    private let endpoints: SourceConnectorManifest.Endpoints
    private let limit: Int
    private let transport: @MainActor (LlmIdeAPIClient) -> any McpConnectorTransport

    init(connectorId: String,
         endpoints: SourceConnectorManifest.Endpoints,
         limit: Int = 50,
         transport: @escaping @MainActor (LlmIdeAPIClient) -> any McpConnectorTransport
            = { LiveMcpConnectorTransport(api: $0) }) {
        self.connectorId = connectorId
        self.endpoints = endpoints
        self.limit = limit
        self.transport = transport
    }

    func fetch(_ ctx: SourceContext) async throws -> SourceConnectorFetchBatch {
        let r = try await transport(ctx.api).fetch(path: endpoints.fetch, id: connectorId, limit: limit)
        return SourceConnectorFetchBatch(
            items: r.items.map { item in
                var fields = item.fields
                fields[Self.itemIdField] = item.id
                return SourceConnectorFetchedItem(fields: fields, body: item.body)
            },
            drained: r.drained,
            overCap: r.skipped.overCap,
            // Partial failures are reported, never swallowed — the sweep still
            // imported whatever the healthy parents produced.
            failures: r.failures)
    }

    func markSeen(_ ctx: SourceContext, batch: SourceConnectorFetchBatch, drained: Bool) async throws {
        let ids = batch.items.compactMap { $0.fields[Self.itemIdField] }
        // `drained` is deliberately unused. Unlike Slack there is no high-water
        // to advance, so it has nothing to gate: every item that reached the
        // inbox is imported whether or not the source fully drained. Marking
        // only on `drained` would re-import every capped batch forever.
        guard !ids.isEmpty else { return }
        try await transport(ctx.api).markSeen(path: endpoints.seen, id: connectorId, itemIds: ids)
    }

    func classifyRequest(from item: RawInboxItem) -> ClassifyRequest {
        ClassifyRequest(body: [
            // The classify route is shared by every MCP connector, so the id
            // is what tells the classifier what it is reading.
            "connectorId": connectorId,
            "title": item.headers["Subject"] ?? "",
            "date": item.headers["Date"] ?? "",
            "text": item.body,
        ])
    }
}

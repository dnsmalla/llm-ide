import Foundation

/// The single declarative list of input sources and the lookups everything
/// source-related uses (classification, Library SOURCES display, ingestion).
/// Adding a source is one entry here plus its `InputSource` struct.
enum SourceRegistry {
    /// Connector ids that have a matching server descriptor in
    /// `extension/connectors/mcp-connector-defs.mjs`. Three manifests ship
    /// (`Resources/source_connectors/`), but registering one whose server side
    /// does not exist yet would put a permanently-empty group in the Library
    /// and add a doomed round trip to every ingestion tick. Phase 3 adds
    /// "gdrive" and "gcal" here — one line, once their descriptors land.
    private static let shippedConnectorIds: Set<String> = ["miro"]

    /// Manifest-driven Source Connectors. The engine shipped in July 2026 with
    /// no manifests; these are its first. Every MCP-backed connector shares one
    /// generic adapter — the descriptor on the server holds everything
    /// provider-specific, so there is nothing per connector left to write here.
    private static let mcpConnectors: [SourceConnector] = SourceConnectorManifest
        .loadBundled()
        .filter { shippedConnectorIds.contains($0.id) }
        .map { manifest in
            SourceConnector(manifest: manifest,
                            adapterFactory: {
                                // Fresh per fetch — SourceConnector calls this
                                // on every sweep so no state leaks between runs.
                                McpConnectorAdapter(connectorId: manifest.id,
                                                    endpoints: manifest.endpoints)
                            })
        }

    static let all: [InputSource] =
        [MeetingSource(), EmailSource(), SlackSource()] + mcpConnectors

    /// Match a frontmatter `platform` value to its source. Unknown/empty →
    /// the meeting source (preserves the historical default-to-meeting).
    static func source(forPlatform platform: String) -> InputSource {
        let key = platform.lowercased()
        return all.first { $0.platforms.contains(key) } ?? MeetingSource()
    }

    /// Match a raw-inbox directory name under `source/` (e.g. "emails") to
    /// its source, or nil for a directory no source owns (e.g. "documents").
    /// Location is authoritative for classification: every fetch source
    /// writes its raw files into its own directory, so the file's home says
    /// what it is even when it has no readable frontmatter (raw mail is
    /// .txt) — which is how all fetched mail used to land under "Meetings".
    static func source(forRawDirectory dir: String) -> InputSource? {
        all.first { $0.rawDirectoryName == dir }
    }

    static func source(id: String) -> InputSource? {
        all.first { $0.id == id }
    }

    /// Sources the ingestion driver should poll (live-capture is excluded —
    /// it's driven by its own engine).
    static var fetchSources: [InputSource] {
        all.filter { $0.mode == .fetch }
    }
}

import Foundation

/// A heading-bounded section of a document, and the result wrapper a doc→graph
/// producer returns.
///
/// These live in GraphCore rather than beside the producer that creates them
/// because they **cross the engine boundary**: the app holds `[MemoryChunk]` in
/// view state, in its session cache, and in the detail panel, so it must be able
/// to name the type with no graph engine installed. Keeping them in the producer
/// package would make the app fail to compile the moment the engine is
/// unplugged — which is exactly the property the split exists to provide.
public struct MemoryChunk: Identifiable, Sendable, Hashable, Codable {
    /// Stable across runs: short sha256 of the doc path plus the heading path.
    public let id: String
    public let docURL: URL
    /// File name minus extension.
    public let docTitle: String
    /// e.g. `["Section", "Subsection"]`.
    public let headingPath: [String]
    /// Accumulated lines until the next heading at the same or a shallower level.
    public let body: String
    /// Typed via frontmatter `type:` or heading heuristics.
    public let kind: CGNodeKind
    /// Lowercased, from `#hashtags` and frontmatter `tags:`.
    public let tags: [String]
    /// Raw `[[Title]]` targets, case as written.
    public let wikiLinks: [String]
    /// Frontmatter `graph-only: true` — consumers keep this doc out of agent
    /// memory artifacts while still graphing it.
    public let graphOnly: Bool
    /// Frontmatter `related-modules:` — declared code-module affinity, case
    /// preserved because these are paths.
    public let relatedModules: [String]

    public init(id: String, docURL: URL, docTitle: String, headingPath: [String],
                body: String, kind: CGNodeKind, tags: [String], wikiLinks: [String],
                graphOnly: Bool = false, relatedModules: [String] = []) {
        self.id = id; self.docURL = docURL; self.docTitle = docTitle
        self.headingPath = headingPath; self.body = body; self.kind = kind
        self.tags = tags; self.wikiLinks = wikiLinks
        self.graphOnly = graphOnly; self.relatedModules = relatedModules
    }

    public var title: String {
        headingPath.last ?? docTitle
    }

    public var displayHeading: String {
        headingPath.isEmpty ? "(preamble)" : headingPath.joined(separator: " › ")
    }

    // MARK: - Codable

    /// Decodes liberally, because this type is a **wire format between
    /// implementations**, not just an in-process struct. A graph engine
    /// delivered as a plugin may be written in any language, and the
    /// TypeScript implementation of graph-kit models a chunk slightly
    /// differently: it carries `docPath` rather than a `docURL`, and has no
    /// `graphOnly` or `relatedModules` at all. Requiring exact parity would
    /// mean a perfectly good engine's output failed to decode over field names.
    ///
    /// Same principle `CGNode` already applies to absent `position`/`metadata`:
    /// be strict about what is emitted, liberal about what is accepted.
    private enum CodingKeys: String, CodingKey {
        case id, docURL, docPath, docTitle, headingPath, body, kind
        case tags, wikiLinks, graphOnly, relatedModules
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        docTitle = try container.decodeIfPresent(String.self, forKey: .docTitle) ?? ""
        // `docURL` preferred; fall back to `docPath`, which arrives as a plain
        // filesystem path rather than a URL string.
        if let url = try container.decodeIfPresent(URL.self, forKey: .docURL) {
            docURL = url
        } else if let path = try container.decodeIfPresent(String.self, forKey: .docPath) {
            docURL = URL(fileURLWithPath: path)
        } else {
            docURL = URL(fileURLWithPath: "/")
        }
        headingPath = try container.decodeIfPresent([String].self, forKey: .headingPath) ?? []
        body = try container.decodeIfPresent(String.self, forKey: .body) ?? ""
        kind = try container.decodeIfPresent(CGNodeKind.self, forKey: .kind) ?? .memoryChunk
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        wikiLinks = try container.decodeIfPresent([String].self, forKey: .wikiLinks) ?? []
        graphOnly = try container.decodeIfPresent(Bool.self, forKey: .graphOnly) ?? false
        relatedModules = try container.decodeIfPresent([String].self,
                                                       forKey: .relatedModules) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(docURL, forKey: .docURL)
        try container.encode(docTitle, forKey: .docTitle)
        try container.encode(headingPath, forKey: .headingPath)
        try container.encode(body, forKey: .body)
        try container.encode(kind, forKey: .kind)
        try container.encode(tags, forKey: .tags)
        try container.encode(wikiLinks, forKey: .wikiLinks)
        try container.encode(graphOnly, forKey: .graphOnly)
        try container.encode(relatedModules, forKey: .relatedModules)
    }
}

/// What a doc→graph pass produces: the graph, its chunks in document order, and
/// how many documents were read.
public struct GeneratedMemory: Sendable, Codable {
    public let graph: CGData
    /// Flat and ordered — each doc followed by its own chunks.
    public let chunks: [MemoryChunk]
    public let docCount: Int

    public init(graph: CGData, chunks: [MemoryChunk], docCount: Int) {
        self.graph = graph; self.chunks = chunks; self.docCount = docCount
    }

    public static let empty = GeneratedMemory(graph: .empty, chunks: [], docCount: 0)
}

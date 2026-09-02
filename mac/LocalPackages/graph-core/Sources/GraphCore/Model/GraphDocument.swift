import Foundation

/// The canonical, serializable form of a graph — the on-disk / on-the-wire contract
/// shared across language implementations. See `schema/SCHEMA.md` and
/// `schema/graph.schema.json`. JSON shape:
///
///     { "schemaVersion": 1, "nodes": [...], "edges": [...], "layers": [...], "tour": [...] }
public struct GraphDocument: Equatable, Sendable, Codable {
    /// Current schema version emitted by this implementation. Bump on a breaking change.
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let nodes: [CGNode]
    public let edges: [CGEdge]
    public let layers: [UALayer]
    public let tour: [UATourStep]

    public init(_ graph: CGData, schemaVersion: Int = GraphDocument.currentSchemaVersion) {
        self.schemaVersion = schemaVersion
        self.nodes = graph.nodes
        self.edges = graph.edges
        self.layers = graph.layers
        self.tour = graph.tour
    }

    private enum CodingKeys: String, CodingKey { case schemaVersion, nodes, edges, layers, tour }

    // `layers` and `tour` are optional in the schema; default them on decode.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decode(Int.self, forKey: .schemaVersion)
        nodes = try c.decode([CGNode].self, forKey: .nodes)
        edges = try c.decode([CGEdge].self, forKey: .edges)
        layers = try c.decodeIfPresent([UALayer].self, forKey: .layers) ?? []
        tour = try c.decodeIfPresent([UATourStep].self, forKey: .tour) ?? []
    }

    /// The graph payload as a `CGData` (drops the version envelope).
    public var graph: CGData {
        CGData(nodes: nodes, edges: edges, layers: layers, tour: tour)
    }

    // MARK: - JSON

    /// Encode to canonical JSON (sorted keys, pretty-printed) for stable diffs.
    public func jsonData() throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try enc.encode(self)
    }

    /// Decode a `GraphDocument` from canonical JSON, rejecting an unknown major version.
    public static func decode(_ data: Data) throws -> GraphDocument {
        let doc = try JSONDecoder().decode(GraphDocument.self, from: data)
        guard doc.schemaVersion <= GraphDocument.currentSchemaVersion else {
            throw GraphDocumentError.unsupportedSchemaVersion(doc.schemaVersion)
        }
        return doc
    }
}

public enum GraphDocumentError: Error, Equatable, Sendable {
    /// The document declares a schema newer than this implementation understands.
    case unsupportedSchemaVersion(Int)
}

public extension CGData {
    /// Wrap this graph in a versioned `GraphDocument`.
    var document: GraphDocument { GraphDocument(self) }
}

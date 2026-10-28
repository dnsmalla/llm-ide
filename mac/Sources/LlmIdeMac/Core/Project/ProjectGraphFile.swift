import Foundation

/// The project graph in graph-kit's canonical `GraphDocument` JSON shape, as a
/// Core-owned Codable mirror.
///
/// Core must not import GraphCore: the product is only linked when the Graph
/// feature is compiled, and the reduced builds (`build-mac-min`, `-lite`) would
/// fail to resolve it. So the System view's graph travels as bytes in this
/// shape. Field names, the `kind` / `confidence` raw strings and the omission of
/// a zero `position` match GraphCore's `GraphDocument`, `CGNode` and `CGEdge`
/// encoding; `GraphDocumentWireTests` pins that against a GraphCore-encoded sample.
struct ProjectGraphDocument: Equatable, Sendable {
    /// `GraphDocument.currentSchemaVersion` in graph-kit.
    static let schemaVersion = 1

    struct Point: Codable, Equatable, Sendable {
        var x: Double
        var y: Double
    }

    struct Node: Equatable, Sendable {
        var id: String
        var title: String
        /// graph-kit `CGNodeKind` raw value, e.g. `file`.
        var kind: String
        /// A layout hint; nil or zero is omitted on encode, as graph-kit does.
        var position: Point?
        var metadata: [String: String]

        init(id: String, title: String, kind: String, position: Point? = nil, metadata: [String: String] = [:]) {
            self.id = id; self.title = title; self.kind = kind
            self.position = position; self.metadata = metadata
        }
    }

    struct Edge: Equatable, Sendable {
        var fromId: String
        var toId: String
        /// graph-kit `CGEdgeKind` raw value, e.g. `imports`.
        var kind: String
        /// graph-kit `CGEdgeConfidence` raw value: `EXTRACTED`, `INFERRED` or `AMBIGUOUS`.
        var confidence: String
    }

    struct Layer: Codable, Equatable, Sendable {
        var id: String
        var name: String
        var nodeIds: [String]
    }

    struct TourStep: Codable, Equatable, Sendable {
        var nodeId: String
        var title: String
        var body: String
    }

    var nodes: [Node]
    var edges: [Edge]
    var layers: [Layer]
    var tour: [TourStep]

    init(nodes: [Node], edges: [Edge], layers: [Layer] = [], tour: [TourStep] = []) {
        self.nodes = nodes; self.edges = edges; self.layers = layers; self.tour = tour
    }

    /// Canonical JSON bytes (sorted keys, the same keys graph-kit writes), or nil
    /// when encoding fails. Never produces a partial document.
    func jsonData() -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try? encoder.encode(Wire(self))
    }

    /// Decodes graph-kit's `GraphDocument` JSON (what `ProjectGraphRegistry`
    /// providers return). nil when the bytes are not a graph document.
    static func decode(graphDocumentJSON data: Data) -> ProjectGraphDocument? {
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data) else { return nil }
        return wire.document
    }

    // MARK: - Wire shape

    /// The Codable form. Kept private so the public type stays a plain value.
    private struct Wire: Codable {
        let schemaVersion: Int
        let nodes: [WireNode]
        let edges: [WireEdge]
        let layers: [Layer]
        let tour: [TourStep]

        init(_ doc: ProjectGraphDocument) {
            schemaVersion = ProjectGraphDocument.schemaVersion
            nodes = doc.nodes.map(WireNode.init)
            edges = doc.edges.map { WireEdge(fromId: $0.fromId, toId: $0.toId, kind: $0.kind, confidence: $0.confidence) }
            layers = doc.layers
            tour = doc.tour
        }

        var document: ProjectGraphDocument {
            ProjectGraphDocument(
                nodes: nodes.map { ProjectGraphDocument.Node(id: $0.id, title: $0.title, kind: $0.kind,
                                                             position: $0.position, metadata: $0.metadata ?? [:]) },
                edges: edges.map { ProjectGraphDocument.Edge(fromId: $0.fromId, toId: $0.toId,
                                                             kind: $0.kind, confidence: $0.confidence) },
                layers: layers, tour: tour)
        }
    }

    private struct WireNode: Codable {
        let id: String
        let title: String
        let kind: String
        let position: Point?
        let metadata: [String: String]?

        init(_ node: ProjectGraphDocument.Node) {
            id = node.id; title = node.title; kind = node.kind
            // Omit a zero position, as CGNode does.
            position = (node.position).flatMap { $0 == Point(x: 0, y: 0) ? nil : $0 }
            metadata = node.metadata
        }
    }

    private struct WireEdge: Codable {
        let fromId: String
        let toId: String
        let kind: String
        let confidence: String
    }
}

/// Reads the project's code graph from disk: `<repo>/system/graph/graph.json`,
/// the v1.1 file `CodeNoteGenerator` writes.
///
/// The repo is the one `RepoGraphLocator` picks for the project. The conversion
/// is pure (`graph(fromJSON:)`) so it is testable without a project on disk.
///
/// v1.1 shape (only the fields read here):
/// `{ files: [{ path, name?, language?, imports?: [path] }], calls?: [{ from, to, symbol }] }`
/// - One node per file: id and path are the repo-relative path, kind `file`,
///   metadata `path` and `language`.
/// - `imports` become `imports` edges (EXTRACTED); `calls` are file-to-file
///   and become `calls` edges (INFERRED). Edges are deduplicated on
///   (from, to, kind), and an edge whose endpoint is not a file node is
///   dropped, so the result never holds a dangling edge.
enum ProjectGraphFile {
    /// `<repo>/system/graph/graph.json` for the project, or nil when the project
    /// has no graph repo.
    static func fileURL(projectRoot: URL) -> URL? {
        guard let repo = RepoGraphLocator.repoToGraph(projectRoot: projectRoot) else { return nil }
        return GeneratedDataLocator.readableGraphDir(forRepo: repo).appendingPathComponent("graph.json")
    }

    /// The project's graph, or nil when the file is missing, unreadable, or not
    /// a v1.1 graph. Synchronous disk read: callers run it off the main thread.
    static func load(projectRoot: URL) -> ProjectGraphDocument? {
        guard let url = fileURL(projectRoot: projectRoot),
              let data = try? Data(contentsOf: url) else { return nil }
        return graph(fromJSON: data)
    }

    /// Converts v1.1 `graph.json` bytes. nil when the JSON does not decode to the
    /// v1.1 `files` shape.
    static func graph(fromJSON data: Data) -> ProjectGraphDocument? {
        guard let file = try? JSONDecoder().decode(V11.self, from: data) else { return nil }
        return convert(file)
    }

    // MARK: - Decoding

    private struct V11: Decodable {
        let files: [File]
        let calls: [Call]?

        struct File: Decodable {
            let path: String
            let name: String?
            let language: String?
            let imports: [String]?
        }
        struct Call: Decodable {
            let from: String
            let to: String
        }
    }

    private static func convert(_ file: V11) -> ProjectGraphDocument {
        var nodes: [ProjectGraphDocument.Node] = []
        var nodeIds = Set<String>()
        var importsOf: [(from: String, targets: [String])] = []
        for entry in file.files where !nodeIds.contains(entry.path) {
            nodeIds.insert(entry.path)
            let title = entry.name ?? (entry.path as NSString).lastPathComponent
            nodes.append(ProjectGraphDocument.Node(
                id: entry.path, title: title, kind: "file",
                metadata: ["path": entry.path, "language": entry.language ?? ""]))
            importsOf.append((entry.path, entry.imports ?? []))
        }

        var edges: [ProjectGraphDocument.Edge] = []
        var seen = Set<String>()
        func add(_ from: String, _ to: String, _ kind: String, _ confidence: String) {
            guard from != to, nodeIds.contains(from), nodeIds.contains(to) else { return }
            guard seen.insert("\(from)\u{1F}\(to)\u{1F}\(kind)").inserted else { return }
            edges.append(ProjectGraphDocument.Edge(fromId: from, toId: to, kind: kind, confidence: confidence))
        }
        for (from, targets) in importsOf {
            for to in targets { add(from, to, "imports", "EXTRACTED") }
        }
        for call in file.calls ?? [] {
            add(call.from, call.to, "calls", "INFERRED")
        }
        return ProjectGraphDocument(nodes: nodes, edges: edges)
    }
}

/// Keeps a graph within the System view's budget.
///
/// - Nodes: above `maxNodes`, the highest-degree nodes survive (ties keep file
///   order). Degree counts every edge of the input.
/// - Edges: only edges between surviving nodes are kept (dangling edges are
///   always dropped). Then, above `maxEdgesPerNode × kept nodes`, the edges with
///   the highest combined endpoint degree (within the kept edges) survive; ties
///   keep input order. Output keeps input order.
/// - Layers and tour steps are filtered to the surviving nodes.
enum ProjectGraphCap {
    static let maxNodes = 5_000
    static let maxEdgesPerNode = 4

    static func capped(_ graph: ProjectGraphDocument,
                       maxNodes: Int = ProjectGraphCap.maxNodes,
                       maxEdgesPerNode: Int = ProjectGraphCap.maxEdgesPerNode) -> ProjectGraphDocument {
        var nodes = graph.nodes
        if nodes.count > maxNodes {
            let degree = degrees(graph.edges)
            let ranked = graph.nodes.enumerated().sorted { a, b in
                let da = degree[a.element.id] ?? 0
                let db = degree[b.element.id] ?? 0
                if da != db { return da > db }
                return a.offset < b.offset
            }
            let kept = Set(ranked.prefix(maxNodes).map { $0.element.id })
            nodes = graph.nodes.filter { kept.contains($0.id) }
        }

        let ids = Set(nodes.map(\.id))
        let inside = graph.edges.filter { ids.contains($0.fromId) && ids.contains($0.toId) }
        let edgeLimit = maxEdgesPerNode * nodes.count
        var edges = inside
        if inside.count > edgeLimit {
            let degree = degrees(inside)
            let ranked = inside.enumerated().sorted { a, b in
                let sa = (degree[a.element.fromId] ?? 0) + (degree[a.element.toId] ?? 0)
                let sb = (degree[b.element.fromId] ?? 0) + (degree[b.element.toId] ?? 0)
                if sa != sb { return sa > sb }
                return a.offset < b.offset
            }
            let chosen = Set(ranked.prefix(edgeLimit).map(\.offset))
            edges = inside.enumerated().compactMap { chosen.contains($0.offset) ? $0.element : nil }
        }

        return ProjectGraphDocument(
            nodes: nodes,
            edges: edges,
            layers: graph.layers.map { ProjectGraphDocument.Layer(
                id: $0.id, name: $0.name, nodeIds: $0.nodeIds.filter(ids.contains)) },
            tour: graph.tour.filter { ids.contains($0.nodeId) })
    }

    private static func degrees(_ edges: [ProjectGraphDocument.Edge]) -> [String: Int] {
        var degree: [String: Int] = [:]
        for edge in edges {
            degree[edge.fromId, default: 0] += 1
            degree[edge.toId, default: 0] += 1
        }
        return degree
    }
}

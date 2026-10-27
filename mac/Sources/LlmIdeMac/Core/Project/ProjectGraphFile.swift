import Foundation
import GraphCore

/// Reads the project's code graph from disk: `<repo>/system/graph/graph.json`,
/// the v1.1 file `CodeNoteGenerator` writes, converted to graph-kit's `CGData`.
///
/// The repo is the one `RepoGraphLocator` picks for the project. The conversion
/// is pure (`graph(fromJSON:)`) so it is testable without a project on disk.
///
/// v1.1 shape (only the fields read here):
/// `{ files: [{ path, name?, language?, imports?: [path] }], calls?: [{ from, to, symbol }] }`
/// - One node per file: id and path are the repo-relative path, kind `.file`,
///   metadata `path` and `language`.
/// - `imports` become `.imports` edges (extracted); `calls` are file-to-file
///   and become `.calls` edges (inferred). Edges are deduplicated on
///   (from, to, kind), and an edge whose endpoint is not a file node is
///   dropped, so the result never holds a dangling edge.
enum ProjectGraphFile {
    /// `<repo>/system/graph/graph.json` for the project, or nil when the project
    /// has no graph repo.
    static func fileURL(projectRoot: URL) -> URL? {
        guard let repo = RepoGraphLocator.repoToGraph(projectRoot: projectRoot) else { return nil }
        return ProjectLayout(root: repo).graphDir.appendingPathComponent("graph.json")
    }

    /// The project's graph, or nil when the file is missing, unreadable, or not
    /// a v1.1 graph. Synchronous disk read: callers run it off the main thread.
    static func load(projectRoot: URL) -> CGData? {
        guard let url = fileURL(projectRoot: projectRoot),
              let data = try? Data(contentsOf: url) else { return nil }
        return graph(fromJSON: data)
    }

    /// Converts v1.1 `graph.json` bytes to `CGData`. nil when the JSON does not
    /// decode to the v1.1 `files` shape.
    static func graph(fromJSON data: Data) -> CGData? {
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

    private static func convert(_ file: V11) -> CGData {
        var nodes: [CGNode] = []
        var nodeIds = Set<String>()
        var importsOf: [(from: String, targets: [String])] = []
        for entry in file.files where !nodeIds.contains(entry.path) {
            nodeIds.insert(entry.path)
            let title = entry.name ?? (entry.path as NSString).lastPathComponent
            nodes.append(CGNode(id: entry.path, title: title, kind: .file,
                                metadata: ["path": entry.path, "language": entry.language ?? ""]))
            importsOf.append((entry.path, entry.imports ?? []))
        }

        var edges: [CGEdge] = []
        var seen = Set<String>()
        func add(_ from: String, _ to: String, _ kind: CGEdgeKind, _ confidence: CGEdgeConfidence) {
            guard from != to, nodeIds.contains(from), nodeIds.contains(to) else { return }
            guard seen.insert("\(from)\u{1F}\(to)\u{1F}\(kind.rawValue)").inserted else { return }
            edges.append(CGEdge(fromId: from, toId: to, kind: kind, confidence: confidence))
        }
        for (from, targets) in importsOf {
            for to in targets { add(from, to, .imports, .extracted) }
        }
        for call in file.calls ?? [] {
            add(call.from, call.to, .calls, .inferred)
        }
        return CGData(nodes: nodes, edges: edges)
    }
}

/// Keeps a graph within the System view's node budget: above `maxNodes`, the
/// highest-degree nodes survive (ties keep file order), and only edges between
/// survivors are kept. Layers and tour steps are filtered to the survivors too.
enum ProjectGraphCap {
    static let maxNodes = 20_000

    static func capped(_ graph: CGData, maxNodes: Int = ProjectGraphCap.maxNodes) -> CGData {
        guard graph.nodes.count > maxNodes else { return graph }
        var degree: [String: Int] = [:]
        for edge in graph.edges {
            degree[edge.fromId, default: 0] += 1
            degree[edge.toId, default: 0] += 1
        }
        let ranked = graph.nodes.enumerated().sorted { a, b in
            let da = degree[a.element.id] ?? 0
            let db = degree[b.element.id] ?? 0
            if da != db { return da > db }
            return a.offset < b.offset
        }
        let keep = Set(ranked.prefix(maxNodes).map { $0.element.id })
        return CGData(
            nodes: graph.nodes.filter { keep.contains($0.id) },
            edges: graph.edges.filter { keep.contains($0.fromId) && keep.contains($0.toId) },
            layers: graph.layers.map { UALayer(id: $0.id, name: $0.name, nodeIds: $0.nodeIds.filter(keep.contains)) },
            tour: graph.tour.filter { keep.contains($0.nodeId) })
    }
}

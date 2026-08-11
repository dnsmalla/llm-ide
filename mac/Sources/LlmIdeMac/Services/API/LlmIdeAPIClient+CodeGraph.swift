import Foundation
import GraphKit

/// Uploads the structural code graph to the backend so server-side agents can
/// traverse it (`findRelatedSymbols` → code-sync grounding). The Mac app is the
/// only producer of this graph; without this call the server's code_graph
/// tables stay empty and that grounding silently returns nothing.
extension LlmIdeAPIClient {

    /// Wire shape — a deliberately slim projection of `CGData`. Layout
    /// positions and any metadata the server does not store are dropped: a
    /// large repo sends thousands of nodes and the unused fields would be most
    /// of the payload.
    struct CodeGraphNodePayload: Encodable {
        let id: String
        let title: String
        let kind: String
        let metadata: [String: String]

        init(_ node: CGNode) {
            self.id = node.id
            self.title = node.title
            self.kind = node.kind.rawValue
            var meta: [String: String] = [:]
            // Only the fields code_graph_nodes actually persists.
            for key in ["source_file", "line", "language", "doc"] {
                if let v = node.metadata[key], !v.isEmpty { meta[key] = v }
            }
            self.metadata = meta
        }
    }

    struct CodeGraphEdgePayload: Encodable {
        let fromId: String
        let toId: String
        let kind: String
        let confidence: String

        init(_ edge: CGEdge) {
            self.fromId = edge.fromId
            self.toId = edge.toId
            self.kind = edge.kind.rawValue
            self.confidence = edge.confidence.rawValue
        }
    }

    struct CodeGraphIngestResult: Decodable {
        let ok: Bool
        let nodes: Int
        let edges: Int
        let droppedNodes: Int
        let droppedEdges: Int
    }

    /// POST one batch of a repo's structural graph.
    ///
    /// `replace` must be set on the FIRST batch only — it clears the previous
    /// generation's rows, so setting it on every batch would leave just the last
    /// one. The repo path must already be allow-listed (`addUserRepo`); the
    /// server rejects anything else with 403.
    @discardableResult
    func ingestCodeGraph(repoPath: String,
                         nodes: [CGNode],
                         edges: [CGEdge],
                         replace: Bool) async throws -> CodeGraphIngestResult {
        struct Req: Encodable {
            struct Graph: Encodable {
                let nodes: [CodeGraphNodePayload]
                let edges: [CodeGraphEdgePayload]
            }
            let repoPath: String
            let graph: Graph
            let replace: Bool
        }
        let body = Req(repoPath: repoPath,
                       graph: .init(nodes: nodes.map(CodeGraphNodePayload.init),
                                    edges: edges.map(CodeGraphEdgePayload.init)),
                       replace: replace)
        return try await post("/kb/ingest-code-graph", body: body, authenticated: true)
    }
}

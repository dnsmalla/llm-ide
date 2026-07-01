import XCTest
import GraphKit
@testable import LlmIdeMac

/// `GraphPrune.capDegree` is what makes the dense InfiniteBrain doc graph
/// layout-able: it caps each node's edges to its strongest few (input order =
/// strongest first) so the force layout doesn't collapse into a hairball.
final class GraphPruneTests: XCTestCase {

    private func node(_ id: String) -> CGNode { CGNode(id: id, title: id, kind: .memoryChunk) }

    func testCapsEveryNodeDegreeAtTheLimit() {
        // A hub (h) linked to 50 leaves — degree 50 — must drop to <= cap.
        let nodes = [node("h")] + (0..<50).map { node("n\($0)") }
        let edges = (0..<50).map { CGEdge(fromId: "h", toId: "n\($0)", kind: .relatedTo) }
        let pruned = GraphPrune.capDegree(CGData(nodes: nodes, edges: edges), maxDegree: 6)

        var deg: [String: Int] = [:]
        for e in pruned.edges { deg[e.fromId, default: 0] += 1; deg[e.toId, default: 0] += 1 }
        XCTAssertTrue(deg.values.allSatisfy { $0 <= 6 }, "a node exceeded the degree cap")
        XCTAssertEqual(deg["h"], 6, "hub kept exactly the cap")
        XCTAssertEqual(pruned.nodes.count, nodes.count, "pruning never drops nodes")
    }

    func testKeepsStrongestEdgesByInputOrder() {
        // Edges earlier in the array are stronger; with cap 2 on the hub, only
        // the first two survive.
        let nodes = (0..<4).map { node("n\($0)") }
        let edges = [
            CGEdge(fromId: "n0", toId: "n1", kind: .references),  // strongest
            CGEdge(fromId: "n0", toId: "n2", kind: .relatedTo),
            CGEdge(fromId: "n0", toId: "n3", kind: .relatedTo),   // should be dropped
        ]
        let pruned = GraphPrune.capDegree(CGData(nodes: nodes, edges: edges), maxDegree: 2)
        XCTAssertEqual(pruned.edges.count, 2)
        XCTAssertEqual(Set(pruned.edges.map { $0.toId }), ["n1", "n2"])
    }

    func testSparseGraphUnchanged() {
        let nodes = (0..<4).map { node("n\($0)") }
        let edges = [CGEdge(fromId: "n0", toId: "n1", kind: .relatedTo),
                     CGEdge(fromId: "n2", toId: "n3", kind: .relatedTo)]
        let pruned = GraphPrune.capDegree(CGData(nodes: nodes, edges: edges), maxDegree: 6)
        XCTAssertEqual(pruned.edges.count, 2, "already within budget — nothing dropped")
    }
}

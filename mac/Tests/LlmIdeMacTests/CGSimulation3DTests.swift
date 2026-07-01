import XCTest
import simd
import GraphKit
@testable import LlmIdeMac

/// Mirrors CGSimulationTests: a dense hub graph must settle to bounded, finite
/// 3D positions. The velocity clamp (carried over from the 2D sim) makes
/// divergence impossible; unclamped this fixture reaches ~1e20.
final class CGSimulation3DTests: XCTestCase {

    private func node(_ id: String) -> CGNode { CGNode(id: id, title: id, kind: .memoryChunk) }

    /// 1200 nodes; node 0 is a hub linked to all others, every node links to
    /// its next 40 neighbours — ~49k edges, dense enough to diverge unclamped.
    private func denseHubGraph(n: Int = 1200) -> CGData {
        let nodes = (0..<n).map { node("n\($0)") }
        var edges: [CGEdge] = []
        for j in 1..<n { edges.append(CGEdge(fromId: "n0", toId: "n\(j)", kind: .relatedTo)) }
        for i in 1..<n {
            for k in 1...40 {
                let j = (i + k) % n
                if j != i { edges.append(CGEdge(fromId: "n\(i)", toId: "n\(j)", kind: .relatedTo)) }
            }
        }
        return CGData(nodes: nodes, edges: edges)
    }

    func testDenseGraphSettlesToBoundedFinite3DPositions() {
        let sim = CGSimulation3D(data: denseHubGraph())
        sim.settle(maxIterations: 60)
        let pos = sim.positions()

        XCTAssertEqual(pos.count, 1200)
        XCTAssertTrue(pos.values.allSatisfy { $0.x.isFinite && $0.y.isFinite && $0.z.isFinite },
                      "settle produced non-finite positions")

        let xs = pos.values.map { $0.x }, ys = pos.values.map { $0.y }, zs = pos.values.map { $0.z }
        let spanX = xs.max()! - xs.min()!
        let spanY = ys.max()! - ys.min()!
        let spanZ = zs.max()! - zs.min()!
        XCTAssertLessThan(spanX, 100_000, "x diverged — velocity clamp missing?")
        XCTAssertLessThan(spanY, 100_000, "y diverged — velocity clamp missing?")
        XCTAssertLessThan(spanZ, 100_000, "z diverged — velocity clamp missing?")
    }
}

import XCTest
import CoreGraphics
import GraphKit
@testable import LlmIdeMac

/// Regression guard for the force-layout numerical-stability bug.
///
/// A dense doc graph (a real InfiniteBrain had 11k nodes / 700k edges, a single
/// hub with 1377 edges) made `CGSimulation` diverge: a high-degree node
/// accumulates one spring kick per edge each tick — far more than `damping`
/// removes — so velocity, and therefore position, grows without bound. The
/// settled layout reached ~1e27 px, which `fit()` then crushed into a 1px
/// horizontal line on screen. The fix clamps per-node speed so movement is
/// bounded regardless of density.
///
/// Without the clamp this fixture settles to a span of ~1e20; with it the span
/// stays a few hundred px. The assertion (finite + a generous upper bound)
/// fails loudly if the clamp is ever removed or the physics regresses.
final class CGSimulationTests: XCTestCase {

    /// 1200 nodes; node 0 is a hub linked to all others, and every node links to
    /// its next 40 neighbours — ~49k edges, dense enough to diverge unclamped.
    private func denseHubGraph(n: Int = 1200) -> CGData {
        var nodes: [CGNode] = []
        nodes.reserveCapacity(n)
        for i in 0..<n {
            // Spread the initial positions on a golden-angle ring (mirrors the
            // jittered, laid-out input the real settle receives).
            let a = Double(i) * 2.399963
            let p = CGPoint(x: 600 + cos(a) * 300, y: 400 + sin(a) * 300)
            nodes.append(CGNode(id: "n\(i)", title: "n\(i)", kind: .memoryChunk, position: p))
        }
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

    func testDenseGraphSettlesToBoundedFinitePositions() {
        let data = denseHubGraph()
        let sim = CGSimulation(data: data)
        sim.settle(maxIterations: 60)
        let settled = sim.appliedData(to: data)

        let xs = settled.nodes.map { $0.position.x }
        let ys = settled.nodes.map { $0.position.y }

        XCTAssertTrue(settled.nodes.allSatisfy { $0.position.x.isFinite && $0.position.y.isFinite },
                      "settle produced non-finite positions")

        let spanX = xs.max()! - xs.min()!
        let spanY = ys.max()! - ys.min()!
        // Unclamped this fixture reaches ~1e20; clamped it stays in the hundreds.
        // 100_000 is a generous ceiling that still catches a divergence.
        XCTAssertLessThan(spanX, 100_000, "x-extent diverged — velocity clamp missing?")
        XCTAssertLessThan(spanY, 100_000, "y-extent diverged — velocity clamp missing?")
    }
}

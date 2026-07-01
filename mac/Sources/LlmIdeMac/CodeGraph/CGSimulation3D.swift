import Foundation
import simd
import GraphKit

/// 3D force-directed layout — the SIMD3 analogue of `CGSimulation`. Carries
/// over the exact tuning validated for the 2D sim, including the per-node
/// velocity clamp that stops dense graphs (a hub with 1000+ edges) from
/// diverging to astronomically large coordinates. Repulsion is O(n²) per tick;
/// at the app's node counts (≤~1600) this settles in ~1–2s off the main actor.
public final class CGSimulation3D: @unchecked Sendable {

    private struct NodeState {
        let id: String
        var position: SIMD3<Float>
        var velocity: SIMD3<Float> = .zero
    }

    private var nodes: [NodeState]
    private let edges: [CGEdge]

    public init(data: CGData) {
        let n = data.nodes.count
        // Fibonacci-sphere initial spread so superimposed nodes have a
        // direction to separate along (the 3D analogue of the 2D golden-angle
        // jitter). Radius scales with node count so big graphs don't start
        // pathologically dense.
        let radius = Float(max(80, Int(Double(n).squareRoot() * 12)))
        let golden = Float.pi * (3 - (5 as Float).squareRoot())   // ~2.39996
        self.nodes = data.nodes.enumerated().map { idx, node in
            let i = Float(idx)
            let y = n > 1 ? 1 - (i / Float(n - 1)) * 2 : 0        // 1 … -1
            let r = (1 - y * y).squareRoot()
            let theta = golden * i
            let p = SIMD3<Float>(cos(theta) * r, y, sin(theta) * r) * radius
            return NodeState(id: node.id, position: p)
        }
        self.edges = data.edges
    }

    /// Run up to `maxIterations` ticks, stopping early when the peak speed drops
    /// below `threshold`. Safe to call off the main actor.
    public func settle(maxIterations: Int = 150, threshold: Float = 0.4) {
        guard nodes.count > 1 else { return }
        for i in 0..<maxIterations {
            tick()
            if i > 30 {
                let maxV = nodes.reduce(Float(0)) { max($0, length($1.velocity)) }
                if maxV < threshold { break }
            }
        }
    }

    public func positions() -> [String: SIMD3<Float>] {
        Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0.position) })
    }

    private func tick() {
        let n = nodes.count
        guard n > 1 else { return }

        let alpha:       Float = 0.05
        let kRepulsion:  Float = 1500
        let kAttraction: Float = 0.07
        let restLength:  Float = 90
        let damping:     Float = 0.88
        let maxV:        Float = 250

        // Spring attraction along edges.
        let idxById = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($1.id, $0) })
        for e in edges {
            guard let i = idxById[e.fromId], let j = idxById[e.toId] else { continue }
            let delta = nodes[j].position - nodes[i].position
            let d = max(length(delta), 0.1)
            let f = (d - restLength) * kAttraction
            let dir = delta / d
            nodes[i].velocity += f * dir
            nodes[j].velocity -= f * dir
        }

        // O(n²) repulsion (no octree at this scale).
        for i in 0..<n {
            var force = SIMD3<Float>.zero
            let pi = nodes[i].position
            for j in 0..<n where j != i {
                let delta = pi - nodes[j].position
                let d2 = simd_length_squared(delta) + 0.1
                force += (kRepulsion / d2) * (delta / d2.squareRoot())
            }
            nodes[i].velocity += force
        }

        // Centering toward the origin + clamp + integrate.
        for i in 0..<n {
            nodes[i].velocity += -nodes[i].position * 0.03
            let speed = length(nodes[i].velocity)
            if speed > maxV { nodes[i].velocity *= (maxV / speed) }
            nodes[i].position += nodes[i].velocity * alpha
            nodes[i].velocity *= damping
        }
    }
}

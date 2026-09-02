import Foundation
import CoreGraphics
import GraphCore

/// Faithful port of the layout pipeline this upgrade replaces, kept only so the
/// benchmark can report honest before/after numbers on the same input.
///
/// Three stages, in the order the Mac app ran them:
///   1. `capDegree(6)` — keep the first six edges per node in emission order.
///   2. `pieSlice` — one angular slice per node kind, three concentric rings.
///   3. `settle` — un-cooled force integration pulling everything to (600, 400).
///
/// Do not use for anything but comparison.
enum LegacyLayout {

    /// `GraphPrune.capDegree`: greedily keep edges while both endpoints are
    /// under the cap, in input-array order.
    static func capDegree(_ data: CGData, maxDegree: Int = 6) -> CGData {
        guard maxDegree > 0 else { return data }
        var used: [String: Int] = [:]
        var kept: [CGEdge] = []
        for edge in data.edges {
            let from = used[edge.fromId] ?? 0
            let to = used[edge.toId] ?? 0
            if from < maxDegree && to < maxDegree {
                kept.append(edge)
                used[edge.fromId] = from + 1
                used[edge.toId] = to + 1
            }
        }
        return CGData(nodes: data.nodes, edges: kept)
    }

    /// `CodeGraphLayout.compute`: type-clustered pie slices over three rings.
    static func pieSlice(_ raw: CGData, canvasSize: CGSize) -> [CGPoint] {
        guard !raw.nodes.isEmpty else { return [] }
        let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
        let maxRadius = min(canvasSize.width, canvasSize.height) / 2 * 0.85

        let activeKinds = Array(Set(raw.nodes.map(\.kind))).sorted { $0.rawValue < $1.rawValue }
        let grouped = Dictionary(grouping: raw.nodes) { $0.kind }
        let sliceAngle = 2 * Double.pi / Double(max(1, activeKinds.count))

        var positionById: [String: CGPoint] = [:]
        for (kindIndex, kind) in activeKinds.enumerated() {
            guard let group = grouped[kind], !group.isEmpty else { continue }
            let centerAngle = sliceAngle * Double(kindIndex) - Double.pi / 2
            let usable = sliceAngle * 0.7
            let count = group.count
            for (offset, node) in group.enumerated() {
                let t: Double = count > 1 ? Double(offset) / Double(count - 1) : 0.5
                let angle = centerAngle - usable / 2 + usable * t
                let ring = offset % 3
                let radius = Double(maxRadius) * (0.5 + 0.5 * Double(ring + 1) / 3)
                positionById[node.id] = CGPoint(x: center.x + CGFloat(cos(angle) * radius),
                                                y: center.y + CGFloat(sin(angle) * radius))
            }
        }
        return raw.nodes.map { positionById[$0.id] ?? .zero }
    }

    /// `CGSimulation.settle`: fixed-alpha integration, hardcoded attractor,
    /// no cooling schedule, no collision, no degree normalisation.
    static func settle(_ data: CGData, initial: [CGPoint], maxIterations: Int) -> [CGPoint] {
        var positions = initial.enumerated().map { index, point in
            // The original applied a golden-angle 0.5 px nudge before settling.
            let angle = Double(index) * 2.399963
            return CGPoint(x: point.x + CGFloat(cos(angle) * 0.5),
                           y: point.y + CGFloat(sin(angle) * 0.5))
        }
        guard positions.count > 1 else { return positions }
        var velocities = [CGPoint](repeating: .zero, count: positions.count)

        let alpha = 0.05, repulsion = 1500.0, attraction = 0.07
        let restLength = 90.0, damping = 0.88, maxSpeed = 250.0
        let center = CGPoint(x: 600, y: 400)

        var indexById: [String: Int] = [:]
        for (index, node) in data.nodes.enumerated() { indexById[node.id] = index }

        for _ in 0..<maxIterations {
            for edge in data.edges {
                guard let i = indexById[edge.fromId], let j = indexById[edge.toId] else { continue }
                let dx = Double(positions[j].x - positions[i].x)
                let dy = Double(positions[j].y - positions[i].y)
                let distance = max((dx * dx + dy * dy).squareRoot(), 0.1)
                let force = (distance - restLength) * attraction
                let fx = force * (dx / distance), fy = force * (dy / distance)
                velocities[i].x += CGFloat(fx); velocities[i].y += CGFloat(fy)
                velocities[j].x -= CGFloat(fx); velocities[j].y -= CGFloat(fy)
            }
            // O(n²) repulsion — equivalent to the original's Barnes-Hut result
            // but simpler; the lab only runs it on modest baselines.
            for i in 0..<positions.count {
                for j in 0..<positions.count where j != i {
                    let dx = Double(positions[i].x - positions[j].x)
                    let dy = Double(positions[i].y - positions[j].y)
                    let squared = dx * dx + dy * dy + 0.1
                    let force = repulsion / squared
                    let distance = squared.squareRoot()
                    velocities[i].x += CGFloat(force * (dx / distance))
                    velocities[i].y += CGFloat(force * (dy / distance))
                }
            }
            for i in 0..<positions.count {
                velocities[i].x += (center.x - positions[i].x) * 0.03
                velocities[i].y += (center.y - positions[i].y) * 0.03
                let speed = Double((velocities[i].x * velocities[i].x
                    + velocities[i].y * velocities[i].y).squareRoot())
                if speed > maxSpeed {
                    let clamp = CGFloat(maxSpeed / speed)
                    velocities[i].x *= clamp; velocities[i].y *= clamp
                }
                positions[i].x += velocities[i].x * CGFloat(alpha)
                positions[i].y += velocities[i].y * CGFloat(alpha)
                velocities[i].x *= CGFloat(damping)
                velocities[i].y *= CGFloat(damping)
            }
        }
        return positions
    }

    /// `UAHelpers.layoutSize`.
    static func layoutSize(nodeCount: Int) -> CGSize {
        let base: CGFloat = 1200
        let extra = CGFloat(max(0, nodeCount - 100)) * 4
        let side = min(base + extra, 8000)
        return CGSize(width: side, height: side * 0.7)
    }
}

import Foundation
import CoreGraphics

/// Force-directed relaxation with the four properties the previous
/// `CGSimulation` was missing, each of which independently prevented it from
/// producing a settled picture:
///
/// 1. **A cooling schedule.** The old loop ran a fixed `alpha` of 0.05 forever,
///    so forces stayed at full strength to the last tick and the layout never
///    converged — it just wandered until the iteration cap, which is why the
///    same graph looked different every launch. Here `alpha` decays
///    geometrically to `alphaMin`, freezing the layout into a stable minimum.
/// 2. **Degree-normalised link strength.** Every edge used to add an
///    independent spring kick, so a hub with 87 importers received 87 kicks per
///    tick while damping removed a fixed fraction — velocity diverged (a real
///    graph reached ~1e27 px). The workaround was to delete edges until no hub
///    remained (`GraphPrune.capDegree(6)`), which removed 82% of the dependency
///    structure. Scaling each link by `1 / min(degree)` — the standard d3-force
///    normalisation — bounds a hub's total pull regardless of degree, so dense
///    graphs are stable *with all their edges present*.
/// 3. **Collision resolution.** Nodes had no radius, so the layout was free to
///    settle with them overlapping; the previous static layout guaranteed
///    overlap (4.2 px spacing for 5 px nodes) and nothing ever separated them.
/// 4. **Cluster gravity instead of a single global centre.** A lone attractor at
///    a hardcoded `(600, 400)` pulled every disconnected piece into one pile —
///    with 867 components (this repo's real count after pruning) that pile *is*
///    the round blob. Each node is now drawn toward its own community's anchor.
struct ForceDirectedLayout {

    struct Config {
        /// Total ticks. `alpha` is scheduled to reach `alphaMin` at the last one,
        /// so this sets convergence, not just a budget.
        var iterations: Int = 300
        /// Barnes-Hut accuracy. Lower is more exact and slower; 0.9 is the usual
        /// quality/speed compromise for interactive graphs.
        var theta: Double = 0.9
        /// Fraction of velocity retained per tick (d3's 1 - velocityDecay).
        var velocityDecay: Double = 0.6
        /// Repulsion coefficient, multiplied by node mass. Negative = repel.
        var repulsion: Double = -190
        /// Baseline gap between two connected nodes' rims.
        var linkSpacing: Double = 46
        /// Overlap-resolution sweeps per tick.
        var collisionPasses: Int = 2
        /// Pull toward the node's community anchor, keeping clusters compact and
        /// disconnected components in their allotted region.
        var clusterGravity: Double = 0.16
        /// Spring-strength multiplier for an edge whose endpoints are in
        /// different communities.
        ///
        /// Below 1 this is what separates clusters. Undamped, the cross-module
        /// imports in a real codebase pull every community into everything else
        /// and the result is the familiar hairball — measurably so: cluster
        /// separation came out below 1.0, meaning clusters sat closer together
        /// than their own members were spread. Damping the *inter*-community
        /// pull while leaving intra-community springs at full strength is the
        /// standard approach (ForceAtlas2/Gephi); the edges are all still drawn,
        /// they simply stop dictating global position.
        var interCommunityScale: Double = 0.3
        var alphaMin: Double = 0.001
    }

    /// Run the simulation.
    ///
    /// - Parameters:
    ///   - initial: Seed positions; the result is deterministic given these.
    ///   - radii: Drawn radius per node, honoured by collision resolution.
    ///   - masses: Repulsion weight per node — higher pushes harder.
    ///   - anchors: Per-node attractor (its community's centre).
    /// - Returns: Settled positions, in the same index order.
    static func run(topology: GraphTopology,
                    initial: [CGPoint],
                    radii: [Double],
                    masses: [Double],
                    anchors: [CGPoint],
                    community: [Int],
                    config: Config = Config()) -> [CGPoint] {
        let n = topology.nodeCount
        guard n > 1, initial.count == n else { return initial }

        var positions = initial
        var velocityX = [Double](repeating: 0, count: n)
        var velocityY = [Double](repeating: 0, count: n)
        var tree = SpatialTree()

        // Precompute per-link constants. `strength` bounds a hub's aggregate
        // pull; `bias` makes the lower-degree endpoint move further, so a leaf
        // swings toward its hub rather than dragging the hub off-station.
        struct Spring {
            let source: Int, target: Int
            let distance: Double, strength: Double, bias: Double
        }
        let springs: [Spring] = topology.links.map { link in
            let sourceDegree = max(topology.degree[link.source], 1)
            let targetDegree = max(topology.degree[link.target], 1)
            // Strong edges sit closer: a `contains` edge (weight 1.0) pulls its
            // symbol tight to the file, a weak reference stays slack.
            let rim = radii[link.source] + radii[link.target]
            let distance = rim + config.linkSpacing * (1.65 - link.weight)
            let crossesCommunity = community.indices.contains(link.source)
                && community.indices.contains(link.target)
                && community[link.source] != community[link.target]
            let damping = crossesCommunity ? config.interCommunityScale : 1.0
            let strength = link.weight * damping / Double(min(sourceDegree, targetDegree))
            let bias = Double(sourceDegree) / Double(sourceDegree + targetDegree)
            return Spring(source: link.source, target: link.target,
                          distance: distance, strength: strength, bias: bias)
        }

        let iterations = max(1, config.iterations)
        // Geometric schedule that lands exactly on alphaMin at the final tick.
        let alphaDecay = 1 - pow(config.alphaMin, 1 / Double(iterations))
        var alpha = 1.0

        for _ in 0..<iterations {
            alpha += (0 - alpha) * alphaDecay

            // ── Repulsion (Barnes-Hut) ──────────────────────────────────────
            tree.rebuild(positions: positions, masses: masses)
            for i in 0..<n {
                let delta = tree.repulsion(on: i,
                                           positions: positions, masses: masses,
                                           strength: config.repulsion,
                                           theta: config.theta, alpha: alpha)
                velocityX[i] += Double(delta.x)
                velocityY[i] += Double(delta.y)
            }

            // ── Springs ─────────────────────────────────────────────────────
            // Uses velocity-anticipated positions (as d3 does) so a spring
            // reacts to where its endpoints are heading, which damps the
            // oscillation a position-only formulation produces.
            for spring in springs {
                let source = spring.source, target = spring.target
                var dx = Double(positions[target].x) + velocityX[target]
                    - Double(positions[source].x) - velocityX[source]
                var dy = Double(positions[target].y) + velocityY[target]
                    - Double(positions[source].y) - velocityY[source]
                var distance = (dx * dx + dy * dy).squareRoot()
                if distance < 1e-6 {
                    // Coincident: separate along a fixed diagonal so the result
                    // stays reproducible.
                    dx = 0.7071; dy = 0.7071; distance = 1
                }
                let scale = (distance - spring.distance) / distance * alpha * spring.strength
                dx *= scale; dy *= scale
                velocityX[target] -= dx * spring.bias
                velocityY[target] -= dy * spring.bias
                velocityX[source] += dx * (1 - spring.bias)
                velocityY[source] += dy * (1 - spring.bias)
            }

            // ── Cluster gravity ─────────────────────────────────────────────
            for i in 0..<n {
                velocityX[i] += (Double(anchors[i].x) - Double(positions[i].x))
                    * config.clusterGravity * alpha
                velocityY[i] += (Double(anchors[i].y) - Double(positions[i].y))
                    * config.clusterGravity * alpha
            }

            // ── Integrate ───────────────────────────────────────────────────
            for i in 0..<n {
                velocityX[i] *= config.velocityDecay
                velocityY[i] *= config.velocityDecay
                // A finite per-tick step keeps one pathological force from
                // throwing a node off the canvas, and guarantees the loop can
                // never produce a non-finite coordinate.
                let step = (velocityX[i] * velocityX[i] + velocityY[i] * velocityY[i]).squareRoot()
                let limit = 60.0
                if step > limit {
                    let clamp = limit / step
                    velocityX[i] *= clamp
                    velocityY[i] *= clamp
                }
                guard velocityX[i].isFinite, velocityY[i].isFinite else {
                    velocityX[i] = 0; velocityY[i] = 0; continue
                }
                positions[i].x += CGFloat(velocityX[i])
                positions[i].y += CGFloat(velocityY[i])
            }

            // ── Collision ───────────────────────────────────────────────────
            // Late-stage only: separating overlaps while the graph is still
            // coarsely rearranging wastes work and fights the springs.
            if alpha < 0.35 {
                resolveOverlaps(&positions, radii: radii, passes: config.collisionPasses)
            }
        }

        resolveOverlaps(&positions, radii: radii, passes: 4)
        return positions
    }

    // MARK: - Collision

    /// Push apart any two nodes whose drawn circles overlap, using a uniform
    /// grid bucketed at the largest node diameter so each node only tests its
    /// nine neighbouring cells — O(n) per pass for realistic distributions.
    private static func resolveOverlaps(_ positions: inout [CGPoint],
                                        radii: [Double],
                                        passes: Int) {
        let n = positions.count
        guard n > 1 else { return }
        let maxRadius = radii.max() ?? 1
        let cellSize = max(maxRadius * 2, 1)

        for _ in 0..<max(1, passes) {
            var buckets: [Int64: [Int]] = [:]
            buckets.reserveCapacity(n * 2)
            for i in 0..<n {
                let key = cellKey(positions[i], cellSize: cellSize)
                buckets[key, default: []].append(i)
            }

            var moved = false
            for i in 0..<n {
                let cellX = gridIndex(Double(positions[i].x), cellSize)
                let cellY = gridIndex(Double(positions[i].y), cellSize)
                for offsetY in -1...1 {
                    for offsetX in -1...1 {
                        let key = (cellX + Int64(offsetX)) &* 73_856_093
                            ^ (cellY + Int64(offsetY)) &* 19_349_663
                        guard let bucket = buckets[key] else { continue }
                        for j in bucket where j > i {
                            let minimum = radii[i] + radii[j] + 2
                            var dx = Double(positions[j].x) - Double(positions[i].x)
                            var dy = Double(positions[j].y) - Double(positions[i].y)
                            var distance = (dx * dx + dy * dy).squareRoot()
                            if distance >= minimum { continue }
                            if distance < 1e-6 {
                                // Deterministic split direction, varied by index
                                // so a coincident cluster fans out instead of
                                // every pair choosing the same axis.
                                let angle = Double((i &* 2_654_435_761 &+ j) % 360) * .pi / 180
                                dx = cos(angle); dy = sin(angle); distance = 1
                            }
                            // Each node takes half the correction.
                            let push = (minimum - distance) / distance * 0.5
                            let shiftX = dx * push, shiftY = dy * push
                            positions[i].x -= CGFloat(shiftX)
                            positions[i].y -= CGFloat(shiftY)
                            positions[j].x += CGFloat(shiftX)
                            positions[j].y += CGFloat(shiftY)
                            moved = true
                        }
                    }
                }
            }
            if !moved { break }
        }
    }


    /// Bucket a coordinate for the uniform grid.
    ///
    /// `Int64(someDouble)` **traps** on NaN or infinity. Nothing reaches here
    /// with a non-finite coordinate today, but a crash is a far worse failure
    /// mode than a misplaced node, so it is clamped rather than trusted.
    static func gridIndex(_ value: Double, _ cellSize: Double) -> Int64 {
        guard value.isFinite, cellSize > 0 else { return 0 }
        let scaled = (value / cellSize).rounded(.down)
        return Int64(scaled.clamped(to: -1e15...1e15))
    }

    private static func cellKey(_ point: CGPoint, cellSize: Double) -> Int64 {
        let cellX = gridIndex(Double(point.x), cellSize)
        let cellY = gridIndex(Double(point.y), cellSize)
        return cellX &* 73_856_093 ^ cellY &* 19_349_663
    }
}

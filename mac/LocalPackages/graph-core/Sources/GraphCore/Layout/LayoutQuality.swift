import Foundation
import CoreGraphics

/// Objective quality metrics for a computed layout.
///
/// "The graph looks bad" is not actionable, and this package has no test
/// framework available to assert against, so layout quality is measured instead.
/// Each metric targets a specific failure this pipeline actually shipped:
///
/// - `radialConcentration` detects the **ring artefact** — the static pie-slice
///   layout placed every node on one of exactly three concentric radii, so the
///   picture read as a hollow circle. A relaxed layout spreads radii smoothly.
/// - `nodeOverlapRatio` detects illegible crowding — that same layout gave a
///   1000-node kind roughly 4 px of arc per 5 px node.
/// - `modularity` reports whether the clustering found real structure, which
///   distinguishes "this graph is a blob" from "this layout made it a blob".
/// - `componentCount` exposes over-pruning: an edge filter that shatters a
///   codebase into hundreds of disconnected pieces leaves nothing to lay out.
public enum LayoutQuality {

    public struct Report: Sendable, Equatable {
        /// Largest share of nodes falling in any one of 25 equal-width bins of
        /// normalised distance-from-centroid.
        ///
        /// A layout filling a disc evenly scores about 0.08. Concentric rings
        /// score above 0.25 — the higher the value, the more the layout is a
        /// circle rather than a map. **Lower is better.**
        public let radialConcentration: Double
        /// Fraction of nodes whose drawn circle overlaps at least one other.
        /// **Lower is better**; a layout with collision resolution reaches ~0.
        public let nodeOverlapRatio: Double
        /// Coefficient of variation of drawn edge lengths. Very high values mean
        /// a few edges are stretched across the whole canvas. **Lower is
        /// better**, though some spread is expected and healthy.
        public let edgeLengthCV: Double
        /// Newman modularity of the clustering, roughly `-0.5...1`. Above ~0.30
        /// means genuine community structure. **Higher is better.**
        public let modularity: Double
        /// Mean distance between cluster centroids divided by mean cluster
        /// spread. Above ~1.5 means clusters read as distinct groups.
        /// **Higher is better.**
        public let clusterSeparation: Double
        /// Connected components after weight filtering. A healthy code graph is
        /// dominated by one large component. **Lower is better.**
        public let componentCount: Int
        /// Share of nodes in the largest component. **Higher is better.**
        public let largestComponentShare: Double
        /// Estimated edge crossings per sampled edge pair, from a deterministic
        /// sample. **Lower is better.**
        public let edgeCrossingRate: Double

        /// One-line summary for logs.
        public var summary: String {
            String(format:
                "ring=%.3f overlap=%.3f edgeCV=%.2f Q=%.3f sep=%.2f comps=%d largest=%.2f cross=%.4f",
                radialConcentration, nodeOverlapRatio, edgeLengthCV, modularity,
                clusterSeparation, componentCount, largestComponentShare, edgeCrossingRate)
        }
    }

    /// Measure a settled layout. Index-aligned inputs.
    public static func measure(positions: [CGPoint],
                               radii: [Double],
                               topology: GraphTopology,
                               community: [Int]) -> Report {
        let n = positions.count
        guard n > 1 else {
            return Report(radialConcentration: 0, nodeOverlapRatio: 0, edgeLengthCV: 0,
                          modularity: 0, clusterSeparation: 0, componentCount: n,
                          largestComponentShare: n == 1 ? 1 : 0, edgeCrossingRate: 0)
        }

        let groups = topology.componentGroups()
        let largest = groups.first?.count ?? 0

        return Report(
            radialConcentration: radialConcentration(positions),
            nodeOverlapRatio: overlapRatio(positions, radii: radii),
            edgeLengthCV: edgeLengthCV(positions, topology: topology),
            modularity: CommunityDetection.modularity(topology, community: community),
            clusterSeparation: clusterSeparation(positions, community: community),
            componentCount: groups.count,
            largestComponentShare: Double(largest) / Double(n),
            edgeCrossingRate: edgeCrossingRate(positions, topology: topology))
    }

    // MARK: - Individual metrics

    /// Bin normalised radii from the centroid and return the largest bin share.
    static func radialConcentration(_ positions: [CGPoint], bins: Int = 25) -> Double {
        let n = positions.count
        guard n > 1 else { return 0 }
        var centroidX = 0.0, centroidY = 0.0
        for point in positions { centroidX += Double(point.x); centroidY += Double(point.y) }
        centroidX /= Double(n); centroidY /= Double(n)

        var distances = [Double](repeating: 0, count: n)
        var maxDistance = 0.0
        for (index, point) in positions.enumerated() {
            let dx = Double(point.x) - centroidX, dy = Double(point.y) - centroidY
            let distance = (dx * dx + dy * dy).squareRoot()
            distances[index] = distance
            maxDistance = max(maxDistance, distance)
        }
        guard maxDistance > 0 else { return 1 }

        var histogram = [Int](repeating: 0, count: bins)
        for distance in distances {
            let bin = min(bins - 1, Int(distance / maxDistance * Double(bins)))
            histogram[bin] += 1
        }
        return Double(histogram.max() ?? 0) / Double(n)
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

    /// Fraction of nodes overlapping at least one other, via a uniform grid.
    static func overlapRatio(_ positions: [CGPoint], radii: [Double]) -> Double {
        let n = positions.count
        guard n > 1, radii.count == n else { return 0 }
        let cellSize = max((radii.max() ?? 1) * 2, 1)
        var buckets: [Int64: [Int]] = [:]
        for index in 0..<n {
            let cellX = Self.gridIndex(Double(positions[index].x), cellSize)
            let cellY = Self.gridIndex(Double(positions[index].y), cellSize)
            buckets[cellX &* 73_856_093 ^ cellY &* 19_349_663, default: []].append(index)
        }

        var overlapping = Set<Int>()
        for index in 0..<n {
            let cellX = Self.gridIndex(Double(positions[index].x), cellSize)
            let cellY = Self.gridIndex(Double(positions[index].y), cellSize)
            for offsetY in -1...1 {
                for offsetX in -1...1 {
                    let key = (cellX + Int64(offsetX)) &* 73_856_093
                        ^ (cellY + Int64(offsetY)) &* 19_349_663
                    guard let bucket = buckets[key] else { continue }
                    for other in bucket where other != index {
                        let dx = Double(positions[index].x) - Double(positions[other].x)
                        let dy = Double(positions[index].y) - Double(positions[other].y)
                        let minimum = radii[index] + radii[other]
                        if dx * dx + dy * dy < minimum * minimum {
                            overlapping.insert(index)
                            overlapping.insert(other)
                        }
                    }
                }
            }
        }
        return Double(overlapping.count) / Double(n)
    }

    static func edgeLengthCV(_ positions: [CGPoint], topology: GraphTopology) -> Double {
        guard !topology.links.isEmpty else { return 0 }
        var lengths: [Double] = []
        lengths.reserveCapacity(topology.links.count)
        for link in topology.links {
            let dx = Double(positions[link.source].x) - Double(positions[link.target].x)
            let dy = Double(positions[link.source].y) - Double(positions[link.target].y)
            lengths.append((dx * dx + dy * dy).squareRoot())
        }
        let mean = lengths.reduce(0, +) / Double(lengths.count)
        guard mean > 0 else { return 0 }
        let variance = lengths.reduce(0.0) { $0 + ($1 - mean) * ($1 - mean) } / Double(lengths.count)
        return variance.squareRoot() / mean
    }

    /// Mean inter-cluster centroid distance over mean intra-cluster spread.
    static func clusterSeparation(_ positions: [CGPoint], community: [Int]) -> Double {
        guard let count = community.max().map({ $0 + 1 }), count > 1 else { return 0 }
        var sumX = [Double](repeating: 0, count: count)
        var sumY = [Double](repeating: 0, count: count)
        var members = [Int](repeating: 0, count: count)
        for (index, cluster) in community.enumerated() where index < positions.count {
            sumX[cluster] += Double(positions[index].x)
            sumY[cluster] += Double(positions[index].y)
            members[cluster] += 1
        }
        var centroids: [(x: Double, y: Double)] = []
        var present: [Int] = []
        for cluster in 0..<count where members[cluster] > 0 {
            centroids.append((sumX[cluster] / Double(members[cluster]),
                              sumY[cluster] / Double(members[cluster])))
            present.append(cluster)
        }
        guard centroids.count > 1 else { return 0 }

        // Mean spread of members about their own centroid.
        var spreadTotal = 0.0
        var spreadCount = 0
        for (slot, cluster) in present.enumerated() {
            var total = 0.0, seen = 0
            for (index, assigned) in community.enumerated()
            where assigned == cluster && index < positions.count {
                let dx = Double(positions[index].x) - centroids[slot].x
                let dy = Double(positions[index].y) - centroids[slot].y
                total += (dx * dx + dy * dy).squareRoot()
                seen += 1
            }
            if seen > 1 { spreadTotal += total / Double(seen); spreadCount += 1 }
        }
        let meanSpread = spreadCount > 0 ? spreadTotal / Double(spreadCount) : 0
        guard meanSpread > 0 else { return 0 }

        // Mean nearest-neighbour distance between cluster centroids — a fairer
        // measure than all-pairs, which grows with the canvas.
        var nearestTotal = 0.0
        for i in centroids.indices {
            var nearest = Double.greatestFiniteMagnitude
            for j in centroids.indices where j != i {
                let dx = centroids[i].x - centroids[j].x
                let dy = centroids[i].y - centroids[j].y
                nearest = min(nearest, (dx * dx + dy * dy).squareRoot())
            }
            if nearest.isFinite { nearestTotal += nearest }
        }
        return (nearestTotal / Double(centroids.count)) / meanSpread
    }

    /// Deterministically sample edge pairs and count segment intersections.
    static func edgeCrossingRate(_ positions: [CGPoint],
                                 topology: GraphTopology,
                                 sampleLimit: Int = 40_000) -> Double {
        let links = topology.links
        guard links.count > 1 else { return 0 }

        var crossings = 0
        var sampled = 0
        // A fixed co-prime stride walks distinct pairs without an RNG, so the
        // estimate is reproducible.
        let stride = max(1, links.count / 211 + 1)
        var i = 0
        outer: while i < links.count {
            var j = i + stride
            while j < links.count {
                let a = links[i], b = links[j]
                // Shared endpoints meet by definition; not a crossing.
                if a.source != b.source, a.source != b.target,
                   a.target != b.source, a.target != b.target {
                    if segmentsIntersect(positions[a.source], positions[a.target],
                                         positions[b.source], positions[b.target]) {
                        crossings += 1
                    }
                    sampled += 1
                    if sampled >= sampleLimit { break outer }
                }
                j += stride
            }
            i += 1
        }
        guard sampled > 0 else { return 0 }
        return Double(crossings) / Double(sampled)
    }

    private static func segmentsIntersect(_ p1: CGPoint, _ p2: CGPoint,
                                          _ p3: CGPoint, _ p4: CGPoint) -> Bool {
        func orientation(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint) -> Int {
            let value = (Double(b.y) - Double(a.y)) * (Double(c.x) - Double(b.x))
                - (Double(b.x) - Double(a.x)) * (Double(c.y) - Double(b.y))
            if value > 1e-9 { return 1 }
            if value < -1e-9 { return -1 }
            return 0
        }
        let o1 = orientation(p1, p2, p3), o2 = orientation(p1, p2, p4)
        let o3 = orientation(p3, p4, p1), o4 = orientation(p3, p4, p2)
        return o1 != o2 && o3 != o4
    }
}

import Foundation

/// Louvain modularity clustering over a weighted, undirected view of the graph.
///
/// This is the single biggest difference between a graph that reads as a map and
/// one that reads as a hairball. Without clustering, a force layout has only two
/// instructions — "pull along edges, push everything apart" — and every module
/// ends up equidistant from every other. Grouping nodes into communities first
/// lets the layout place *clusters* far apart and their members close together,
/// which is what makes the folder/subsystem structure of a codebase visible.
///
/// It also supplies the one colour channel that scales: colouring by
/// `CGNodeKind` gives at most a handful of meaningful hues (this repo's
/// generators only emit four code kinds), whereas colouring by community shows
/// actual subsystems.
///
/// Deterministic by construction — nodes are visited in index order and ties
/// resolve to the lowest community id, so the same graph always produces the
/// same clustering and therefore the same picture.
public enum CommunityDetection {

    /// Weighted adjacency the algorithm can aggregate between levels.
    private struct Level {
        var neighbours: [[(node: Int, weight: Double)]]
        /// Weight folded into a node by aggregation, counted once.
        var selfLoops: [Double]
        /// Weighted degree: incident weight plus twice each self-loop.
        var degree: [Double]
        /// Sum of all edge weights, self-loops counted once.
        var totalWeight: Double

        init(neighbours: [[(node: Int, weight: Double)]], selfLoops: [Double]) {
            self.neighbours = neighbours
            self.selfLoops = selfLoops
            var degree = [Double](repeating: 0, count: neighbours.count)
            var total = 0.0
            for i in 0..<neighbours.count {
                var incident = 0.0
                for (_, weight) in neighbours[i] { incident += weight }
                degree[i] = incident + 2 * selfLoops[i]
                total += incident / 2 + selfLoops[i]
            }
            self.degree = degree
            self.totalWeight = total
        }
    }

    /// Community id per node index, ids renumbered `0..<k` in ascending order of
    /// each community's lowest member index.
    ///
    /// - Parameters:
    ///   - resolution: Above 1 yields more, smaller communities; below 1 yields
    ///     fewer, larger ones. 1.0 is standard modularity.
    ///   - maxLevels: Aggregation passes. Louvain normally converges in 2–4.
    public static func louvain(_ topology: GraphTopology,
                               resolution: Double = 1.0,
                               maxLevels: Int = 10) -> [Int] {
        let n = topology.nodeCount
        guard n > 0 else { return [] }
        guard !topology.links.isEmpty else { return Array(0..<n) }

        var neighbours = [[(node: Int, weight: Double)]](repeating: [], count: n)
        for link in topology.links {
            // Hierarchical (`contains`) edges bind a symbol to its file far more
            // tightly than a peer reference does; boosting them keeps a file and
            // its members in one community instead of scattering the members
            // across the communities of whatever they happen to call.
            let weight = link.isHierarchical ? link.weight * 1.6 : link.weight
            neighbours[link.source].append((link.target, weight))
            neighbours[link.target].append((link.source, weight))
        }

        var level = Level(neighbours: neighbours,
                          selfLoops: [Double](repeating: 0, count: n))
        // Maps every original node to its super-node index at the current level.
        // After each level it is lifted to the new community numbering, so on
        // exit it is already the answer in `0..<k` terms.
        var assignment = Array(0..<n)

        for _ in 0..<maxLevels {
            let local = moveNodes(level, resolution: resolution)
            guard local.improved else { break }

            let renumbered = renumber(local.community)
            // Community id per node *of this level*, densely numbered.
            let communityOfLevelNode = local.community.map { renumbered.map[$0] ?? 0 }
            // Lift: an original node inherits the community of the super-node
            // it currently belongs to.
            assignment = assignment.map { communityOfLevelNode[$0] }

            // Nothing merged — another aggregation pass would be identical.
            guard renumbered.count < level.neighbours.count else { break }
            level = aggregate(level,
                              communityOfLevelNode: communityOfLevelNode,
                              communityCount: renumbered.count)
        }

        return assignment
    }

    // MARK: - Phase 1: local moving

    private static func moveNodes(_ level: Level,
                                  resolution: Double) -> (community: [Int], improved: Bool) {
        let n = level.neighbours.count
        var community = Array(0..<n)
        var communityDegree = level.degree
        let twiceTotal = 2 * level.totalWeight
        guard twiceTotal > 0 else { return (community, false) }

        var improvedOverall = false
        // Louvain's inner loop; each sweep is O(edges). The cap stops a
        // pathological oscillation between two equal-modularity assignments.
        for _ in 0..<20 {
            var movedThisSweep = false
            for node in 0..<n {
                let origin = community[node]
                let nodeDegree = level.degree[node]

                var weightToCommunity: [Int: Double] = [:]
                for (neighbour, weight) in level.neighbours[node] where neighbour != node {
                    weightToCommunity[community[neighbour], default: 0] += weight
                }

                communityDegree[origin] -= nodeDegree
                let originGain = (weightToCommunity[origin] ?? 0)
                    - resolution * communityDegree[origin] * nodeDegree / twiceTotal

                var bestCommunity = origin
                var bestGain = originGain
                // Sorted for determinism: with `>` the lowest id wins a tie.
                for candidate in weightToCommunity.keys.sorted() {
                    guard candidate != origin else { continue }
                    let gain = weightToCommunity[candidate]!
                        - resolution * communityDegree[candidate] * nodeDegree / twiceTotal
                    if gain > bestGain + 1e-12 {
                        bestGain = gain
                        bestCommunity = candidate
                    }
                }

                community[node] = bestCommunity
                communityDegree[bestCommunity] += nodeDegree
                if bestCommunity != origin {
                    movedThisSweep = true
                    improvedOverall = true
                }
            }
            if !movedThisSweep { break }
        }
        return (community, improvedOverall)
    }

    // MARK: - Phase 2: aggregation

    /// Collapse each community into one super-node, summing intra-community
    /// weight into a self-loop and inter-community weight into new edges.
    private static func aggregate(_ level: Level,
                                  communityOfLevelNode: [Int],
                                  communityCount: Int) -> Level {
        var selfLoops = [Double](repeating: 0, count: communityCount)
        var merged = [[Int: Double]](repeating: [:], count: communityCount)

        for node in 0..<level.neighbours.count {
            let source = communityOfLevelNode[node]
            selfLoops[source] += level.selfLoops[node]
            for (neighbour, weight) in level.neighbours[node] {
                let target = communityOfLevelNode[neighbour]
                if source == target {
                    // Each intra-community edge is visited from both ends.
                    selfLoops[source] += weight / 2
                } else {
                    merged[source][target, default: 0] += weight
                }
            }
        }

        let neighbours = merged.map { row in
            row.keys.sorted().map { (node: $0, weight: row[$0]!) }
        }
        return Level(neighbours: neighbours, selfLoops: selfLoops)
    }

    // MARK: - Helpers

    /// Renumber sparse community ids to `0..<k`, ordered by first appearance so
    /// the result is stable.
    private static func renumber(_ community: [Int]) -> (map: [Int: Int], count: Int) {
        var map: [Int: Int] = [:]
        var next = 0
        for id in community where map[id] == nil {
            map[id] = next
            next += 1
        }
        return (map, next)
    }

    /// Node indices grouped by community, largest first — the order a layout
    /// places clusters in, so the biggest subsystem takes the centre.
    public static func groups(_ community: [Int]) -> [[Int]] {
        guard let count = community.max().map({ $0 + 1 }), count > 0 else { return [] }
        var groups = [[Int]](repeating: [], count: count)
        for (node, id) in community.enumerated() where id >= 0 { groups[id].append(node) }
        return groups
            .filter { !$0.isEmpty }
            .sorted { ($0.count, $1.first ?? 0) > ($1.count, $0.first ?? 0) }
    }

    /// Newman modularity of a clustering, in roughly `-0.5...1`. Above ~0.3
    /// means the community structure is real rather than an artefact; used by
    /// `LayoutQuality` to report whether clustering found anything.
    public static func modularity(_ topology: GraphTopology,
                                  community: [Int]) -> Double {
        let totalWeight = topology.links.reduce(0.0) { $0 + $1.weight }
        guard totalWeight > 0 else { return 0 }
        guard let count = community.max().map({ $0 + 1 }), count > 0 else { return 0 }

        var internalWeight = [Double](repeating: 0, count: count)
        var totalDegree = [Double](repeating: 0, count: count)
        for link in topology.links {
            let source = community[link.source], target = community[link.target]
            if source == target { internalWeight[source] += link.weight }
            totalDegree[source] += link.weight
            totalDegree[target] += link.weight
        }

        var score = 0.0
        for c in 0..<count {
            let fraction = internalWeight[c] / totalWeight
            let expected = totalDegree[c] / (2 * totalWeight)
            score += fraction - expected * expected
        }
        return score
    }
}

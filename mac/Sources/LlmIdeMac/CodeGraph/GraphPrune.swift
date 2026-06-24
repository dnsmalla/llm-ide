import Foundation
import GraphKit

/// Caps how many edges any single node keeps, so a pathologically dense graph
/// can be laid out and rendered legibly.
///
/// The InfiniteBrain doc graph over-generates edges: `MemoryGenerator`'s
/// whole-word title-match and tag co-occurrence rules connect a chunk to every
/// other chunk that merely mentions its title, so a real repo produced ~702k
/// edges across 11k nodes (avg degree 124, one hub with 1377). No force-layout
/// parameter can separate a graph that dense — springs always collapse it into
/// a hairball, and the canvas chokes drawing hundreds of thousands of lines.
/// Measured: pruning to maxDegree 6 drops that to ~18k edges and the layout
/// settles into a readable, spread cluster instead of a blob/line.
///
/// Edges are kept in input order, which is significant: `MemoryGenerator` emits
/// the strongest relations first (explicit wiki-links / references), then
/// weaker tag co-occurrence, then the noisy title-match fallback. Greedily
/// keeping the earliest edges therefore preserves each node's most meaningful
/// links and discards the noise.
enum GraphPrune {
    /// Keep an edge only while *both* endpoints are still under `maxDegree`.
    /// Returns the graph unchanged when it's already within budget.
    static func capDegree(_ data: CGData, maxDegree: Int) -> CGData {
        guard maxDegree > 0 else { return data }
        // Fast path: nothing to do if every node is already under budget.
        var degree: [String: Int] = [:]
        for e in data.edges {
            degree[e.fromId, default: 0] += 1
            degree[e.toId,   default: 0] += 1
        }
        if degree.values.allSatisfy({ $0 <= maxDegree }) { return data }

        var kept: [CGEdge] = []
        kept.reserveCapacity(min(data.edges.count, data.nodes.count * maxDegree))
        var used: [String: Int] = [:]
        for e in data.edges {
            let a = used[e.fromId] ?? 0
            let b = used[e.toId]   ?? 0
            if a < maxDegree && b < maxDegree {
                kept.append(e)
                used[e.fromId] = a + 1
                used[e.toId]   = b + 1
            }
        }
        return CGData(nodes: data.nodes, edges: kept,
                      layers: data.layers, tour: data.tour)
    }
}

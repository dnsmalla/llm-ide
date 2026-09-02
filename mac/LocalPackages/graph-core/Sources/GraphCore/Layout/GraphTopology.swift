import Foundation

/// Index-based adjacency over a `CGData`, plus the derived structural signals a
/// layout or a renderer needs: degree, weighted degree, PageRank, and connected
/// components.
///
/// These signals were previously recomputed ad hoc in three unrelated places and
/// discarded each time — `CodeGraphUploadService.nodePriority` (to decide upload
/// truncation), `KnowledgeGraphService.renderGraphNotes` (to print dependency
/// hubs), and `CodeNoteGenerator.writeIndex` (to list high-impact files) — so
/// nothing that draws the graph could size or rank a node. Computing them once,
/// here, over integer indices makes them cheap enough to be the basis of both
/// layout and visual encoding.
///
/// Node ids are mapped to a dense `0..<n` index range once; every algorithm in
/// `Layout/` works in that space and converts back only at the boundary.
public struct GraphTopology: Sendable {

    /// Dense index for each node id, in `nodes` order.
    public let indexById: [String: Int]
    /// Node ids by dense index — the inverse of `indexById`.
    public let idByIndex: [String]

    /// One entry per edge that survived the weight filter, in index space.
    public struct Link: Sendable {
        public let source: Int
        public let target: Int
        public let weight: Double
        public let kind: CGEdgeKind
        public let isHierarchical: Bool
    }

    public let links: [Link]

    /// Undirected neighbour lists (`neighbors[i]` = indices adjacent to `i`).
    /// Parallel edges are collapsed; `weightedDegree` keeps their total pull.
    public let neighbors: [[Int]]

    /// Count of distinct undirected neighbours per node.
    public let degree: [Int]
    /// Sum of incident edge weights per node — the mass a force layout uses, so
    /// a hub joined by strong structural edges outweighs one joined by guesses.
    public let weightedDegree: [Double]
    /// Incoming edge count per node, following edge direction. For `imports`
    /// this is "how many files depend on me" — the dependency-hub signal.
    public let inDegree: [Int]

    public var nodeCount: Int { idByIndex.count }

    /// Build the topology, keeping only edges at or above `minWeight`.
    ///
    /// Filtering here rather than deleting edges upstream is the whole point:
    /// the caller still owns the full graph, so a UI weight slider can rebuild
    /// a denser topology without regenerating anything.
    public init(_ data: CGData, minWeight: Double = EdgeWeight.defaultMinWeight) {
        var index: [String: Int] = [:]
        index.reserveCapacity(data.nodes.count)
        var ids: [String] = []
        ids.reserveCapacity(data.nodes.count)
        for node in data.nodes where index[node.id] == nil {
            index[node.id] = ids.count
            ids.append(node.id)
        }
        self.indexById = index
        self.idByIndex = ids

        let n = ids.count
        var builtLinks: [Link] = []
        builtLinks.reserveCapacity(data.edges.count)
        var neighbourSets = [Set<Int>](repeating: [], count: n)
        var wDegree = [Double](repeating: 0, count: n)
        var inDeg = [Int](repeating: 0, count: n)

        // Collapse parallel edges (`StructureGraphBuilder` emits one `calls`
        // edge per call site, so A→B can repeat dozens of times) into a single
        // link whose weight grows sub-linearly with multiplicity. Multiplicity
        // is real signal — 30 calls is a tighter coupling than 1 — but linear
        // growth would let one chatty pair dominate every force in the layout.
        var linkIndexByPair: [Int: Int] = [:]
        linkIndexByPair.reserveCapacity(data.edges.count)
        // Per-collapsed-link accumulators, index-aligned with `builtLinks`.
        var peakWeight: [Double] = []
        var otherWeightTotal: [Double] = []
        var peakKind: [CGEdgeKind] = []
        var hierarchical: [Bool] = []

        for edge in data.edges {
            guard let source = index[edge.fromId], let target = index[edge.toId],
                  source != target
            else { continue }
            let weight = EdgeWeight.weight(of: edge)
            guard weight >= minWeight else { continue }

            inDeg[target] += 1
            let key = source < target ? source * n + target : target * n + source
            if let existing = linkIndexByPair[key] {
                // Accumulate the pair's peak weight and the total of its other
                // edges SEPARATELY, then derive the collapsed weight from both.
                //
                // Folding each new edge against the running total made the
                // result depend on emission order once a pair had three or more
                // edges: all six permutations of 0.40/0.58/0.65 produced two
                // different weights, and comparing a new edge against the
                // already-bumped total could reject a genuinely stronger one.
                // Peak and sum are both commutative, so the collapsed link is
                // now identical for any ordering of the same edge multiset.
                if weight > peakWeight[existing] {
                    otherWeightTotal[existing] += peakWeight[existing]
                    peakWeight[existing] = weight
                    peakKind[existing] = edge.kind
                } else {
                    otherWeightTotal[existing] += weight
                }
                hierarchical[existing] = hierarchical[existing]
                    || EdgeWeight.isHierarchical(edge.kind)
                continue
            }
            linkIndexByPair[key] = builtLinks.count
            peakWeight.append(weight)
            otherWeightTotal.append(0)
            peakKind.append(edge.kind)
            hierarchical.append(EdgeWeight.isHierarchical(edge.kind))
            builtLinks.append(Link(source: source, target: target, weight: weight,
                                   kind: edge.kind,
                                   isHierarchical: EdgeWeight.isHierarchical(edge.kind)))
            neighbourSets[source].insert(target)
            neighbourSets[target].insert(source)
        }

        // Finalise each collapsed link, and only now accumulate weighted degree
        // — doing it incrementally required patching up deltas as the weight
        // changed, which is what made the accumulation order-sensitive.
        for index in builtLinks.indices {
            let link = builtLinks[index]
            let weight = min(1.0, peakWeight[index] + otherWeightTotal[index] * 0.15)
            builtLinks[index] = Link(source: link.source, target: link.target,
                                     weight: weight, kind: peakKind[index],
                                     isHierarchical: hierarchical[index])
            wDegree[link.source] += weight
            wDegree[link.target] += weight
        }

        self.links = builtLinks
        // Sorted so every downstream traversal is deterministic — the layout
        // must produce the same picture for the same graph on every launch.
        self.neighbors = neighbourSets.map { $0.sorted() }
        self.degree = neighbourSets.map(\.count)
        self.weightedDegree = wDegree
        self.inDegree = inDeg
    }

    // MARK: - Derived signals

    /// Weighted PageRank in `0...1`, normalised so the most important node is
    /// 1.0. This is the importance signal a renderer sizes nodes by: unlike raw
    /// degree it distinguishes a file imported by 20 leaf scripts from one
    /// imported by 20 files that are themselves widely imported.
    public func pageRank(damping: Double = 0.85, iterations: Int = 40) -> [Double] {
        let n = nodeCount
        guard n > 0 else { return [] }
        guard n > 1 else { return [1.0] }

        // Out-weight per node, following edge direction, so rank flows the way
        // dependencies point.
        var outWeight = [Double](repeating: 0, count: n)
        for link in links { outWeight[link.source] += link.weight }

        var rank = [Double](repeating: 1.0 / Double(n), count: n)
        let teleport = (1 - damping) / Double(n)

        for _ in 0..<iterations {
            var next = [Double](repeating: teleport, count: n)
            var danglingMass = 0.0
            for i in 0..<n where outWeight[i] == 0 { danglingMass += rank[i] }
            // A node with no outgoing edges would otherwise leak its rank out of
            // the system; redistribute it uniformly, as the standard formulation
            // does, so the vector stays a probability distribution.
            let spread = damping * danglingMass / Double(n)
            for i in 0..<n { next[i] += spread }
            for link in links where outWeight[link.source] > 0 {
                next[link.target] += damping * rank[link.source]
                    * (link.weight / outWeight[link.source])
            }
            rank = next
        }

        let peak = rank.max() ?? 1
        guard peak > 0 else { return rank }
        return rank.map { $0 / peak }
    }

    /// Connected-component id per node, ids assigned in ascending order of the
    /// component's lowest member index so the numbering is deterministic.
    ///
    /// Components matter for layout because a force simulation cannot position
    /// disconnected pieces relative to each other — repulsion alone pushes them
    /// apart forever, and a global centering force instead crushes them into one
    /// overlapping pile. They must be laid out separately and packed.
    public func components() -> [Int] {
        let n = nodeCount
        var component = [Int](repeating: -1, count: n)
        var next = 0
        var stack: [Int] = []
        for start in 0..<n where component[start] == -1 {
            component[start] = next
            stack.append(start)
            while let node = stack.popLast() {
                for neighbour in neighbors[node] where component[neighbour] == -1 {
                    component[neighbour] = next
                    stack.append(neighbour)
                }
            }
            next += 1
        }
        return component
    }

    /// Node indices grouped by component, largest component first.
    public func componentGroups() -> [[Int]] {
        let component = components()
        guard let count = component.max().map({ $0 + 1 }), count > 0 else { return [] }
        var groups = [[Int]](repeating: [], count: count)
        for (node, id) in component.enumerated() { groups[id].append(node) }
        return groups.sorted { ($0.count, $1.first ?? 0) > ($1.count, $0.first ?? 0) }
    }
}

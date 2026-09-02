import Foundation
import CoreGraphics

/// Tuning for a graph layout pass.
public struct GraphLayoutOptions: Sendable {
    /// Edges below this weight are excluded from layout (see `EdgeWeight`).
    /// Nothing is deleted — raise or lower it to rebuild a denser or sparser
    /// view of the same graph.
    public var minWeight: Double = EdgeWeight.defaultMinWeight
    /// Louvain resolution. Above 1 gives more, smaller clusters.
    public var clusterResolution: Double = 1.0
    /// Simulation ticks. Scaled down for very large graphs by `automatic`.
    public var iterations: Int = 300
    /// Smallest and largest drawn node radius, in layout units. Node size
    /// encodes PageRank importance between these bounds.
    public var minNodeRadius: Double = 5
    public var maxNodeRadius: Double = 26
    /// Gap between adjacent clusters, as a multiple of cluster radius.
    public var clusterSpacing: Double = 1.28
    /// Compute layout quality metrics. Cheap for small graphs, sampled above.
    public var measureQuality: Bool = true

    public init() {}

    /// Options scaled to a graph's size: large graphs get fewer ticks (each is
    /// O(n log n)) and smaller nodes so the picture stays legible when fitted.
    public static func automatic(nodeCount: Int) -> GraphLayoutOptions {
        var options = GraphLayoutOptions()
        switch nodeCount {
        case ..<200:
            options.iterations = 400
        case ..<800:
            options.iterations = 320
        case ..<2500:
            options.iterations = 240
            options.maxNodeRadius = 22
        case ..<8000:
            options.iterations = 170
            options.minNodeRadius = 4
            options.maxNodeRadius = 18
        default:
            options.iterations = 120
            options.minNodeRadius = 3
            options.maxNodeRadius = 14
        }
        return options
    }
}

/// Everything a renderer needs to draw a graph well, computed once.
///
/// Previously the canvas received only `CGData` with positions and had to
/// recompute adjacency on every redraw to size a node, while the importance
/// signals that already existed elsewhere in the app were thrown away. Carrying
/// them here means the renderer encodes real structure — size by importance,
/// colour by cluster, edge prominence by weight — instead of guessing.
public struct GraphLayout: Sendable {
    /// Settled position per node id.
    public let positions: [String: CGPoint]
    /// Cluster id per node id, dense from 0. Renderers colour by this.
    public let community: [String: Int]
    /// Number of distinct clusters.
    public let communityCount: Int
    /// Normalised PageRank in `0...1`; 1.0 is the most important node.
    public let importance: [String: Double]
    /// Drawn radius per node id, in layout units — already reflects importance
    /// and was honoured by collision resolution, so these circles do not
    /// overlap.
    public let radius: [String: Double]
    /// Undirected degree per node id, after weight filtering.
    public let degree: [String: Int]
    /// Incoming edge count per node id — "how many things depend on me".
    public let inDegree: [String: Int]
    /// Edge weight per `fromId→toId` pair that survived the filter, so the
    /// renderer can style prominence without recomputing.
    public let edgeWeight: [String: Double]
    /// Bounding box of the settled positions.
    public let bounds: CGRect
    /// Measured quality of this layout, when requested.
    public let quality: LayoutQuality.Report?

    /// Key for `edgeWeight` lookups.
    public static func edgeKey(_ fromId: String, _ toId: String) -> String {
        "\(fromId)\u{1}\(toId)"
    }

    public static let empty = GraphLayout(
        positions: [:], community: [:], communityCount: 0, importance: [:],
        radius: [:], degree: [:], inDegree: [:], edgeWeight: [:],
        bounds: .zero, quality: nil)
}

/// Computes a cluster-aware, deterministic layout for a `CGData`.
///
/// Replaces the previous two-stage `CodeGraphLayout` → `CGSimulation` pipeline,
/// whose first stage published a type-clustered pie-slice **circle** straight to
/// the screen and cached it as if final, while the second stage's force-directed
/// result was dropped by several guards. Whether the user saw the circle or the
/// settled blob depended on timing — the inconsistency this replaces.
///
/// There is now one entry point that returns one finished layout. Nothing
/// partial is ever published, so the picture cannot change identity underneath
/// the viewport, and a given graph always produces the same picture.
public enum GraphLayoutEngine {

    /// Lay out a graph. Pure and deterministic: equal input gives equal output,
    /// with no reliance on wall-clock timing or RNG. Safe off the main actor.
    public static func layout(_ data: CGData,
                              options: GraphLayoutOptions? = nil) -> GraphLayout {
        guard !data.nodes.isEmpty else { return .empty }
        let options = options ?? .automatic(nodeCount: data.nodes.count)

        let topology = GraphTopology(data, minWeight: options.minWeight)
        let n = topology.nodeCount
        guard n > 0 else { return .empty }

        let importance = topology.pageRank()
        let community = CommunityDetection.louvain(topology,
                                                  resolution: options.clusterResolution)
        let groups = CommunityDetection.groups(community)

        // Radius encodes importance. `sqrt` because area, not radius, is what
        // the eye compares — a linear map makes hubs cartoonishly large.
        let span = options.maxNodeRadius - options.minNodeRadius
        let radii: [Double] = (0..<n).map { index in
            options.minNodeRadius + span * (importance[index].squareRoot())
        }
        // Repulsion mass: a well-connected node claims proportionally more room.
        let masses: [Double] = (0..<n).map { index in
            1 + topology.weightedDegree[index].squareRoot()
        }

        let anchors = clusterAnchors(groups: groups, radii: radii, nodeCount: n,
                                     spacing: options.clusterSpacing)
        let seed = seedPositions(groups: groups, anchors: anchors,
                                 radii: radii, nodeCount: n)

        var config = ForceDirectedLayout.Config()
        config.iterations = options.iterations
        let settled = ForceDirectedLayout.run(topology: topology, initial: seed,
                                              radii: radii, masses: masses,
                                              anchors: anchors, community: community,
                                              config: config)

        // ── Package by node id ───────────────────────────────────────────────
        var positions: [String: CGPoint] = [:]
        var communityById: [String: Int] = [:]
        var importanceById: [String: Double] = [:]
        var radiusById: [String: Double] = [:]
        var degreeById: [String: Int] = [:]
        var inDegreeById: [String: Int] = [:]
        positions.reserveCapacity(n)
        for index in 0..<n {
            let id = topology.idByIndex[index]
            positions[id] = settled[index]
            communityById[id] = community.indices.contains(index) ? community[index] : 0
            importanceById[id] = importance[index]
            radiusById[id] = radii[index]
            degreeById[id] = topology.degree[index]
            inDegreeById[id] = topology.inDegree[index]
        }

        var edgeWeight: [String: Double] = [:]
        edgeWeight.reserveCapacity(topology.links.count * 2)
        for link in topology.links {
            let source = topology.idByIndex[link.source]
            let target = topology.idByIndex[link.target]
            // Both orientations: the renderer walks real edges, whose direction
            // may be either way round relative to the collapsed link.
            edgeWeight[GraphLayout.edgeKey(source, target)] = link.weight
            edgeWeight[GraphLayout.edgeKey(target, source)] = link.weight
        }

        let quality = options.measureQuality
            ? LayoutQuality.measure(positions: settled, radii: radii,
                                    topology: topology, community: community)
            : nil

        return GraphLayout(
            positions: positions,
            community: communityById,
            communityCount: groups.count,
            importance: importanceById,
            radius: radiusById,
            degree: degreeById,
            inDegree: inDegreeById,
            edgeWeight: edgeWeight,
            bounds: boundingBox(settled, radii: radii),
            quality: quality)
    }

    /// Derive the visual-encoding signals for a graph that is **already
    /// positioned**, without running the simulation.
    ///
    /// Needed because positions are cached but the signals are not. A consumer
    /// that restores a positioned graph from a cache otherwise has no clusters,
    /// no importance and no edge weights — so it would colour by a stale
    /// clustering, or by none at all. Reusing the cached positions keeps the
    /// picture identical; only the encoding is recovered.
    ///
    /// Cheap relative to `layout`: topology, PageRank and Louvain, but no force
    /// iterations and no collision passes.
    public static func signals(of data: CGData,
                               options: GraphLayoutOptions? = nil) -> GraphLayout {
        guard !data.nodes.isEmpty else { return .empty }
        let options = options ?? .automatic(nodeCount: data.nodes.count)

        let topology = GraphTopology(data, minWeight: options.minWeight)
        let n = topology.nodeCount
        guard n > 0 else { return .empty }

        let importance = topology.pageRank()
        let community = CommunityDetection.louvain(topology,
                                                  resolution: options.clusterResolution)
        let groups = CommunityDetection.groups(community)
        let span = options.maxNodeRadius - options.minNodeRadius
        let radii: [Double] = (0..<n).map { index in
            options.minNodeRadius + span * (importance[index].squareRoot())
        }

        var positions: [String: CGPoint] = [:]
        var communityById: [String: Int] = [:]
        var importanceById: [String: Double] = [:]
        var radiusById: [String: Double] = [:]
        var degreeById: [String: Int] = [:]
        var inDegreeById: [String: Int] = [:]
        let positionById = Dictionary(data.nodes.map { ($0.id, $0.position) },
                                      uniquingKeysWith: { first, _ in first })
        var settled = [CGPoint](repeating: .zero, count: n)
        for index in 0..<n {
            let id = topology.idByIndex[index]
            let point = positionById[id] ?? .zero
            positions[id] = point
            settled[index] = point
            communityById[id] = community.indices.contains(index) ? community[index] : 0
            importanceById[id] = importance[index]
            radiusById[id] = radii[index]
            degreeById[id] = topology.degree[index]
            inDegreeById[id] = topology.inDegree[index]
        }

        var edgeWeight: [String: Double] = [:]
        edgeWeight.reserveCapacity(topology.links.count * 2)
        for link in topology.links {
            let source = topology.idByIndex[link.source]
            let target = topology.idByIndex[link.target]
            edgeWeight[GraphLayout.edgeKey(source, target)] = link.weight
            edgeWeight[GraphLayout.edgeKey(target, source)] = link.weight
        }

        return GraphLayout(
            positions: positions, community: communityById,
            communityCount: groups.count, importance: importanceById,
            radius: radiusById, degree: degreeById, inDegree: inDegreeById,
            edgeWeight: edgeWeight,
            bounds: boundingBox(settled, radii: radii),
            quality: options.measureQuality
                ? LayoutQuality.measure(positions: settled, radii: radii,
                                        topology: topology, community: community)
                : nil)
    }

    /// Apply a layout's positions to a graph, so callers that still pass `CGData`
    /// around get positioned nodes. Layers and tour are preserved — every
    /// previous transform in this pipeline silently dropped them.
    public static func applying(_ layout: GraphLayout, to data: CGData) -> CGData {
        let nodes = data.nodes.map { node in
            CGNode(id: node.id, title: node.title, kind: node.kind,
                   position: layout.positions[node.id] ?? node.position,
                   metadata: node.metadata)
        }
        return CGData(nodes: nodes, edges: data.edges,
                      layers: data.layers, tour: data.tour)
    }

    // MARK: - Seeding

    /// Place one anchor per cluster so clusters do not overlap, then give every
    /// member of a cluster that anchor.
    ///
    /// Clusters are packed largest-first along a golden-angle spiral, each
    /// rejected outward until it clears every cluster already placed. Compared
    /// with the previous pie-slice seed this matters twice over: it gives the
    /// simulation a start that already reflects the graph's real grouping (so it
    /// converges instead of staying trapped in its initial rings), and it keeps
    /// disconnected components — of which a pruned code graph had 867 — in
    /// separate territory rather than stacked at one point.
    private static func clusterAnchors(groups: [[Int]], radii: [Double],
                                       nodeCount: Int, spacing: Double) -> [CGPoint] {
        var anchors = [CGPoint](repeating: .zero, count: nodeCount)
        guard !groups.isEmpty else { return anchors }

        // Radius a cluster needs: enough area for its members plus breathing room.
        let clusterRadii: [Double] = groups.map { members in
            let area = members.reduce(0.0) { total, index in
                let radius = radii[index] + 6
                return total + radius * radius * .pi
            }
            // /0.62 ≈ the packing slack a relaxed disc arrangement needs.
            return max((area / .pi / 0.62).squareRoot(), 30)
        }

        let goldenAngle = 2.399963229728653
        var placed: [(center: CGPoint, radius: Double)] = []
        placed.reserveCapacity(groups.count)
        let largestRadius = clusterRadii.max() ?? 1

        // Uniform grid over placed clusters, so each candidate tests only its
        // neighbourhood. All-pairs testing was O(groups² × steps): the 867
        // components a fragmented real graph produces meant ~10⁸ distance
        // checks, and every extra cluster made it worse.
        let cellSize = max(largestRadius * 2 * spacing, 1)
        var grid: [Int64: [Int]] = [:]
        func cellKey(_ x: Double, _ y: Double) -> Int64 {
            // Same finite-guarded bucketing the force layout uses; a raw
            // `Int64(Double)` traps on NaN/infinity.
            let cx = ForceDirectedLayout.gridIndex(x, cellSize)
            let cy = ForceDirectedLayout.gridIndex(y, cellSize)
            return cx &* 73_856_093 ^ cy &* 19_349_663
        }
        func overlapsPlaced(_ candidate: CGPoint, radius: Double) -> Bool {
            let cx = ForceDirectedLayout.gridIndex(Double(candidate.x), cellSize)
            let cy = ForceDirectedLayout.gridIndex(Double(candidate.y), cellSize)
            // A cluster's own radius never exceeds `largestRadius`, and the cell
            // is sized to that, so any overlap is within one cell either way.
            for oy in -1...1 {
                for ox in -1...1 {
                    let key = (cx + Int64(ox)) &* 73_856_093 ^ (cy + Int64(oy)) &* 19_349_663
                    guard let bucket = grid[key] else { continue }
                    for index in bucket {
                        let dx = Double(candidate.x - placed[index].center.x)
                        let dy = Double(candidate.y - placed[index].center.y)
                        let needed = (radius + placed[index].radius) * spacing
                        if dx * dx + dy * dy < needed * needed { return true }
                    }
                }
            }
            return false
        }

        for (groupIndex, members) in groups.enumerated() {
            let radius = clusterRadii[groupIndex]
            var center = CGPoint.zero
            if !placed.isEmpty {
                // Walk outward along the spiral until this disc clears the rest.
                var step = 0
                let stride = max(radius * 0.55, 18)
                var found = false
                while step < 60_000 {
                    let t = Double(step)
                    let spiralRadius = stride * t.squareRoot()
                    let angle = goldenAngle * t
                    let candidate = CGPoint(x: spiralRadius * cos(angle),
                                            y: spiralRadius * sin(angle))
                    if !overlapsPlaced(candidate, radius: radius) {
                        center = candidate
                        found = true
                        break
                    }
                    step += 1
                }
                if !found {
                    // Never silently stack on the origin — that put the cluster
                    // on top of the largest one with no indication. Place it
                    // beyond everything already positioned instead.
                    let outermost = placed.reduce(0.0) { limit, entry in
                        max(limit, (Double(entry.center.x) * Double(entry.center.x)
                                    + Double(entry.center.y) * Double(entry.center.y))
                            .squareRoot() + entry.radius)
                    }
                    let angle = goldenAngle * Double(groupIndex)
                    let ring = outermost + (radius + largestRadius) * spacing
                    center = CGPoint(x: ring * cos(angle), y: ring * sin(angle))
                }
            }
            grid[cellKey(Double(center.x), Double(center.y)), default: []].append(placed.count)
            placed.append((center, radius))
            for member in members { anchors[member] = center }
        }
        return anchors
    }

    /// Deterministic seed positions: each node on a phyllotaxis (sunflower)
    /// spiral around its cluster anchor.
    ///
    /// Phyllotaxis is used rather than a ring because it fills a disc evenly at
    /// any count. The previous seed placed nodes on exactly three concentric
    /// rings (`ring = i % 3`) whatever the node count, which both guaranteed
    /// overlap at scale and left the disc's centre empty — the hollow ring the
    /// user sees whenever the simulation's result is discarded.
    private static func seedPositions(groups: [[Int]], anchors: [CGPoint],
                                      radii: [Double], nodeCount: Int) -> [CGPoint] {
        var positions = [CGPoint](repeating: .zero, count: nodeCount)
        let goldenAngle = 2.399963229728653
        for members in groups {
            guard let anchor = members.first.map({ anchors[$0] }) else { continue }
            // Spread proportional to member size so big nodes are not seeded on
            // top of each other.
            let averageRadius = members.reduce(0.0) { $0 + radii[$1] }
                / Double(max(members.count, 1))
            let stride = max(averageRadius * 2.1, 12)
            for (offset, member) in members.enumerated() {
                let t = Double(offset)
                let spiralRadius = stride * t.squareRoot()
                let angle = goldenAngle * t
                positions[member] = CGPoint(
                    x: anchor.x + CGFloat(spiralRadius * cos(angle)),
                    y: anchor.y + CGFloat(spiralRadius * sin(angle)))
            }
        }
        return positions
    }

    private static func boundingBox(_ positions: [CGPoint], radii: [Double]) -> CGRect {
        guard let first = positions.first else { return .zero }
        var minX = Double(first.x), maxX = minX
        var minY = Double(first.y), maxY = minY
        for (index, point) in positions.enumerated() {
            let radius = index < radii.count ? radii[index] : 0
            minX = min(minX, Double(point.x) - radius)
            maxX = max(maxX, Double(point.x) + radius)
            minY = min(minY, Double(point.y) - radius)
            maxY = max(maxY, Double(point.y) + radius)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
}

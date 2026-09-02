import Foundation
import CoreGraphics
import GraphCore

/// Headless layout benchmark and regression gate.
///
/// This toolchain has neither XCTest nor swift-testing (Command Line Tools with
/// no Xcode), so the layout engine's correctness is asserted by this executable:
/// it lays out a set of graphs shaped like the ones the app really produces,
/// measures them, compares against the pipeline being replaced, checks hard
/// invariants, and exits non-zero if any fails.
///
/// Usage:
///   graph-layout-lab                      run the gate on synthetic graphs
///   graph-layout-lab --svg <dir>          also write SVG previews
///   graph-layout-lab --json <graph.json>  measure a real canonical graph
///   graph-layout-lab --compare            include legacy before/after columns

struct Case {
    let name: String
    let data: CGData
    /// Legacy comparison is O(n²); skip it on the large cases.
    let compareToLegacy: Bool
    /// Whether graph connectivity is this case's own responsibility.
    ///
    /// For synthetic cases the generator controls the wiring, so a shattered
    /// graph means the weight filter is over-pruning — a real regression. For a
    /// graph loaded from disk, fragmentation is a property of whatever produced
    /// it: the real repo graph genuinely arrives with 129 components and every
    /// one of its 1589 doc chunks disconnected from the code, because doc→code
    /// linking is weak upstream. Failing the layout gate for that would blame
    /// the wrong component, so it is reported as a diagnostic instead.
    let ownsConnectivity: Bool
}

struct Failure {
    let caseName: String
    let check: String
    let detail: String
}

// MARK: - Arguments

let arguments = Array(CommandLine.arguments.dropFirst())
func flagValue(_ flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}
let svgDirectory = flagValue("--svg")
let jsonPath = flagValue("--json")
let wantsCompare = arguments.contains("--compare") || svgDirectory != nil

// MARK: - Cases

var cases: [Case] = []
var failures: [Failure] = []

/// A graph engine's output: the canonical document plus the doc-track extras.
/// Mirrors what `PluginGraphEngine` decodes, so this gate doubles as an
/// interop check on a real plugin's JSON.
struct LabEngineOutput: Decodable {
    let nodes: [CGNode]
    let edges: [CGEdge]
    let layers: [UALayer]?
    let tour: [UATourStep]?
    let chunks: [MemoryChunk]?
    let docCount: Int?
}

if let jsonPath {
    let url = URL(fileURLWithPath: jsonPath)
    // Interop: a plugin-produced file carries `chunks`/`docCount` alongside the
    // graph, and models a chunk differently from the Swift side (`docPath`
    // instead of `docURL`, no `graphOnly`/`relatedModules`). Decoding it here
    // proves the tolerant `MemoryChunk` decoder actually accepts real output
    // rather than only the Swift encoder's own.
    if let data = try? Data(contentsOf: url),
       let engineOutput = try? JSONDecoder().decode(LabEngineOutput.self, from: data),
       let chunks = engineOutput.chunks, !chunks.isEmpty {
        print("")
        print("▸ interop: decoded \(chunks.count) chunks from engine output"
              + " (docCount=\(engineOutput.docCount.map(String.init) ?? "—"))")
        let withBodies = chunks.filter { !$0.body.isEmpty }.count
        let withTitles = chunks.filter { !$0.title.isEmpty }.count
        print("          \(withBodies) carry a body, \(withTitles) resolve a title")
        if withBodies == 0 {
            failures.append(Failure(caseName: "interop", check: "chunk bodies",
                                    detail: "every decoded chunk has an empty body"))
        }
    }
    do {
        let document = try JSONDecoder().decode(GraphDocument.self, from: Data(contentsOf: url))
        cases.append(Case(name: "real:\(url.lastPathComponent)",
                          data: CGData(nodes: document.nodes, edges: document.edges,
                                       layers: document.layers, tour: document.tour),
                          compareToLegacy: document.nodes.count <= 3000,
                          ownsConnectivity: false))
    } catch {
        FileHandle.standardError.write(
            "failed to read \(jsonPath): \(error)\n".data(using: .utf8)!)
        exit(2)
    }
} else {
    let smallCode = SyntheticGraph.codebase(modules: 6, filesPerModule: 8, symbolsPerFile: 5)
    let mediumCode = SyntheticGraph.codebase(modules: 14, filesPerModule: 16, symbolsPerFile: 6)
    let largeCode = SyntheticGraph.codebase(modules: 30, filesPerModule: 30, symbolsPerFile: 8)
    let noisyDocs = SyntheticGraph.docSet(docs: 60, chunksPerDoc: 8, noisePerChunk: 14)

    cases = [
        Case(name: "code/small", data: smallCode,
             compareToLegacy: true, ownsConnectivity: true),
        Case(name: "code/medium", data: mediumCode,
             compareToLegacy: true, ownsConnectivity: true),
        Case(name: "code/large", data: largeCode,
             compareToLegacy: false, ownsConnectivity: true),
        Case(name: "docs/noisy", data: noisyDocs,
             compareToLegacy: true, ownsConnectivity: true),
        Case(name: "all/merged",
             data: SyntheticGraph.merged(code: mediumCode, doc: noisyDocs),
             compareToLegacy: false, ownsConnectivity: true),
        // Many small disconnected components — the shape a real pruned graph
        // had (867) and what `clusterAnchors` was rewritten to handle. Nothing
        // else here exceeds 8 components, so without this the cluster packer's
        // cost and its no-overlap guarantee go unmeasured.
        Case(name: "fragmented/900", data: SyntheticGraph.fragmented(components: 900),
             compareToLegacy: false, ownsConnectivity: false),
    ]
}

func check(_ condition: Bool, _ caseName: String, _ name: String, _ detail: String) {
    if !condition { failures.append(Failure(caseName: caseName, check: name, detail: detail)) }
}

// MARK: - Louvain known answers
//
// `testLayoutIsDeterministic` is near-tautological — same pure function, same
// input, no RNG — so it cannot catch the real risk here, which is `Dictionary`
// or `Set` iteration order leaking into the clustering. These are published
// reference values; any of them moving means the algorithm changed.

func auditLouvain() {
    func graph(_ n: Int, _ pairs: [(Int, Int)]) -> CGData {
        CGData(nodes: (0..<n).map { CGNode(id: "n\($0)", title: "n\($0)", kind: .file) },
               edges: pairs.map {
                   CGEdge(fromId: "n\($0.0)", toId: "n\($0.1)",
                          kind: .imports, confidence: .extracted)
               })
    }
    func clique(_ members: [Int]) -> [(Int, Int)] {
        var pairs: [(Int, Int)] = []
        for i in 0..<members.count {
            for j in (i + 1)..<members.count { pairs.append((members[i], members[j])) }
        }
        return pairs
    }

    // Zachary's karate club — the canonical community-detection benchmark.
    let karate: [(Int, Int)] = [
        (0,1),(0,2),(0,3),(0,4),(0,5),(0,6),(0,7),(0,8),(0,10),(0,11),(0,12),
        (0,13),(0,17),(0,19),(0,21),(0,31),(1,2),(1,3),(1,7),(1,13),(1,17),
        (1,19),(1,21),(1,30),(2,3),(2,7),(2,8),(2,9),(2,13),(2,27),(2,28),
        (2,32),(3,7),(3,12),(3,13),(4,6),(4,10),(5,6),(5,10),(5,16),(6,16),
        (8,30),(8,32),(8,33),(9,33),(13,33),(14,32),(14,33),(15,32),(15,33),
        (18,32),(18,33),(19,33),(20,32),(20,33),(22,32),(22,33),(23,25),(23,27),
        (23,29),(23,32),(23,33),(24,25),(24,27),(24,31),(25,31),(26,29),(26,33),
        (27,33),(28,31),(28,33),(29,32),(29,33),(30,32),(30,33),(31,32),(31,33),
        (32,33),
    ]

    // Hoisted out of the array literal below: inline, the concatenation of a
    // flatMap and a map defeated the type checker.
    var ringOfCliques: [(Int, Int)] = []
    for group in 0..<8 {
        ringOfCliques += clique([group * 4, group * 4 + 1, group * 4 + 2, group * 4 + 3])
    }
    for group in 0..<8 {
        ringOfCliques.append((group * 4, ((group + 1) % 8) * 4))
    }
    var pathPairs: [(Int, Int)] = []
    for index in 0..<39 { pathPairs.append((index, index + 1)) }

    struct Expectation {
        let label: String
        let data: CGData
        let clusters: Int
        /// nil when only the cluster count is pinned.
        let modularity: Double?
    }

    let cases: [Expectation] = [
        Expectation(label: "two-K5", data: graph(10, clique([0,1,2,3,4]) + clique([5,6,7,8,9])),
                    clusters: 2, modularity: 0.5000),
        Expectation(label: "two-K5-bridge",
                    data: graph(10, clique([0,1,2,3,4]) + clique([5,6,7,8,9]) + [(4,5)]),
                    clusters: 2, modularity: 0.4524),
        Expectation(label: "karate", data: graph(34, karate),
                    clusters: 4, modularity: 0.4188),
        Expectation(label: "8xK4-ring", data: graph(32, ringOfCliques),
                    clusters: 8, modularity: 0.7321),
        Expectation(label: "path-40", data: graph(40, pathPairs),
                    clusters: 5, modularity: nil),
        Expectation(label: "K12", data: graph(12, clique(Array(0..<12))),
                    clusters: 1, modularity: nil),
        Expectation(label: "isolated-20", data: graph(20, []),
                    clusters: 20, modularity: nil),
    ]

    print("")
    print("▸ louvain — published reference values")
    for expectation in cases {
        let topology = GraphTopology(expectation.data)
        let community = CommunityDetection.louvain(topology)
        let groups = CommunityDetection.groups(community)
        let modularity = CommunityDetection.modularity(topology, community: community)

        check(groups.count == expectation.clusters, "louvain/\(expectation.label)",
              "cluster count", "found \(groups.count), expected \(expectation.clusters)")
        if let expected = expectation.modularity {
            check(abs(modularity - expected) < 0.002, "louvain/\(expectation.label)",
                  "modularity", String(format: "Q=%.4f, expected %.4f", modularity, expected))
        }
        // Dense, non-negative ids with no gaps.
        let ids = Set(community)
        check(ids == Set(0..<groups.count), "louvain/\(expectation.label)",
              "ids dense from 0", "got \(ids.sorted().prefix(12))…")
        // Re-run must be byte-identical: this is where a Set/Dictionary
        // iteration-order leak would surface.
        check(CommunityDetection.louvain(topology) == community,
              "louvain/\(expectation.label)", "deterministic",
              "a second run produced a different clustering")
        print(String(format: "  %-14s n=%-3d k=%-3d Q=%.4f",
                     (expectation.label as NSString).utf8String!,
                     expectation.data.nodes.count, groups.count, modularity))
    }
}

// MARK: - Barnes-Hut ground truth
//
// The quality metrics passed a repulsion calculation that was 1094% wrong,
// because a diffuse force field still yields a spread, clustered, non-ring
// picture. Structure and force are therefore asserted directly, against ground
// truth, before any of the scene metrics are trusted.

func auditSpatialTree() {
    struct Rng { // deterministic; a fixed layout must give a fixed verdict
        var state: UInt64 = 0x2545F4914F6CDD1D
        mutating func next() -> Double {
            state ^= state << 13; state ^= state >> 7; state ^= state << 17
            return Double(state % 1_000_000) / 1_000_000
        }
    }

    func run(_ label: String, positions: [CGPoint], masses: [Double]) {
        var tree = SpatialTree()
        tree.rebuild(positions: positions, masses: masses)
        let audit = tree.audit()
        let n = positions.count

        // Every point stored exactly once — not dropped, not duplicated.
        check(audit.storedPointCount == n, "spatial-tree/\(label)", "stores every point once",
              "stored \(audit.storedPointCount) of \(n)")
        // Mass conserved at the root.
        let expectedMass = masses.reduce(0) { $0 + max($1, 0.0001) }
        check(abs(audit.rootMass - expectedMass) < 1e-6, "spatial-tree/\(label)",
              "conserves mass",
              String(format: "root mass %.4f, expected %.4f", audit.rootMass, expectedMass))
        // Upper bound on cells. Coincident points legitimately descend to the
        // depth limit trying to separate, costing 4 cells per level, so the
        // bound has to allow for that — 3 identical points really do build 81
        // cells. The load-bearing checks here are `storedPointCount` and the
        // theta=0 exactness below; this one only catches gross explosion (the
        // broken tree built 12,109 cells for 500 points against a 2,081 bound).
        let maxDepth = 20
        let cellBudget = 4 * (n + maxDepth) + 1
        check(audit.cellCount <= cellBudget, "spatial-tree/\(label)", "cell count sane",
              "built \(audit.cellCount) cells for \(n) points (budget \(cellBudget))")

        // theta = 0 forces a full descent, so the approximation must reproduce
        // the exact N² sum. This is the assertion that catches a wrong tree.
        var worstError = 0.0
        var exactMagnitude = 0.0
        for i in 0..<min(n, 24) {
            let approx = tree.repulsion(on: i, positions: positions,
                                        masses: masses, strength: -190, theta: 0, alpha: 1)
            let exact = SpatialTree.exactRepulsion(on: i, positions: positions,
                                                   masses: masses, strength: -190, alpha: 1)
            worstError += abs(Double(approx.x - exact.x)) + abs(Double(approx.y - exact.y))
            exactMagnitude += abs(Double(exact.x)) + abs(Double(exact.y))
        }
        let relative = exactMagnitude > 0 ? worstError / exactMagnitude : worstError
        check(relative < 1e-9, "spatial-tree/\(label)", "theta=0 matches exact N²",
              String(format: "relative L1 error %.4f%%", relative * 100))

        // theta=0 descends every cell, so it never reads an internal cell's
        // mass or centre of mass — the exact accounting the original bug got
        // wrong. Check those directly.
        let integrity = tree.cellIntegrity(positions: positions, masses: masses)
        check(integrity.mass < 1e-6, "spatial-tree/\(label)", "cell mass matches subtree",
              String(format: "worst mass error %.3e", integrity.mass))
        check(integrity.centre < 1e-6, "spatial-tree/\(label)",
              "cell centre of mass matches subtree",
              String(format: "worst centre error %.3e", integrity.centre))

        // And the approximation path itself, at the theta the app ships.
        var approxError = 0.0
        var approxMagnitude = 0.0
        for i in 0..<min(n, 24) {
            let approx = tree.repulsion(on: i, positions: positions, masses: masses,
                                        strength: -190, theta: 0.9, alpha: 1)
            let exact = SpatialTree.exactRepulsion(on: i, positions: positions,
                                                   masses: masses, strength: -190, alpha: 1)
            approxError += abs(Double(approx.x - exact.x)) + abs(Double(approx.y - exact.y))
            approxMagnitude += abs(Double(exact.x)) + abs(Double(exact.y))
        }
        let approximate = approxMagnitude > 0 ? approxError / approxMagnitude : 0
        check(approximate < 0.06, "spatial-tree/\(label)", "theta=0.9 within tolerance",
              String(format: "relative L1 error %.2f%% (expect a few percent)",
                     approximate * 100))
        print(String(format: "  %-14s n=%-5d cells=%-6d points=%-5d maxLeaf=%-3d "
                     + "exact=%.1e mass=%.1e com=%.1e bh0.9=%.2f%%",
                     (label as NSString).utf8String!, n, audit.cellCount,
                     audit.storedPointCount, audit.maxLeafOccupancy, relative,
                     integrity.mass, integrity.centre, approximate * 100))
    }

    print("")
    print("▸ spatial tree — structure + Barnes-Hut vs exact N²")
    run("pair", positions: [CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 100)],
        masses: [1, 1])
    // Exactly coincident: repulsion must be non-zero, or such nodes can never
    // be separated. The old code returned exactly (0, 0) here.
    let coincident = [CGPoint(x: 5, y: 5), CGPoint(x: 5, y: 5), CGPoint(x: 5, y: 5)]
    run("coincident", positions: coincident, masses: [1, 1, 1])
    var tree = SpatialTree()
    tree.rebuild(positions: coincident, masses: [1, 1, 1])
    let force = tree.repulsion(on: 0, positions: coincident,
                               masses: [1, 1, 1], strength: -190, theta: 0.9, alpha: 1)
    check(abs(Double(force.x)) + abs(Double(force.y)) > 1e-6,
          "spatial-tree/coincident", "coincident points repel",
          "force is zero, so a pile can never separate")

    var rng = Rng()
    let scattered = (0..<500).map { _ in
        CGPoint(x: rng.next() * 1000, y: rng.next() * 1000)
    }
    run("scattered500", positions: scattered,
        masses: (0..<500).map { 1 + Double($0 % 7) })
    // A grid puts many points on exact cell boundaries — the routing case the
    // previous implementation silently dropped points on.
    let grid = (0..<256).map { CGPoint(x: Double($0 % 16) * 64, y: Double($0 / 16) * 64) }
    run("grid256", positions: grid, masses: Array(repeating: 2, count: 256))
}

print("")
print("graph-layout-lab — layout quality gate")
print(String(repeating: "═", count: 96))

auditSpatialTree()
auditLouvain()

for testCase in cases {
    let data = testCase.data
    print("")
    print("▸ \(testCase.name)  —  \(data.nodes.count) nodes, \(data.edges.count) edges")

    // ── New engine ───────────────────────────────────────────────────────────
    let started = Date()
    let layout = GraphLayoutEngine.layout(data)
    let elapsed = Date().timeIntervalSince(started)
    guard let quality = layout.quality else {
        failures.append(Failure(caseName: testCase.name, check: "quality",
                                detail: "no report produced"))
        continue
    }

    print("  new     \(quality.summary)   [\(String(format: "%.2fs", elapsed))]")
    print("          clusters=\(layout.communityCount)")

    // ── Legacy baseline ──────────────────────────────────────────────────────
    var legacyPositions: [CGPoint] = []
    if wantsCompare && testCase.compareToLegacy {
        let pruned = LegacyLayout.capDegree(data, maxDegree: 6)
        let canvas = LegacyLayout.layoutSize(nodeCount: pruned.nodes.count)
        let seeded = LegacyLayout.pieSlice(pruned, canvasSize: canvas)
        // The circle the user sees when the settle result is dropped.
        let ringTopology = GraphTopology(pruned)
        let ringCommunity = CommunityDetection.louvain(ringTopology)
        let ringRadii = [Double](repeating: 5, count: seeded.count)
        let ringQuality = LayoutQuality.measure(positions: seeded, radii: ringRadii,
                                                topology: ringTopology,
                                                community: ringCommunity)
        print("  legacy-ring   \(ringQuality.summary)")

        legacyPositions = LegacyLayout.settle(pruned, initial: seeded, maxIterations: 200)
        let settledQuality = LayoutQuality.measure(positions: legacyPositions,
                                                   radii: ringRadii,
                                                   topology: ringTopology,
                                                   community: ringCommunity)
        print("  legacy-settled \(settledQuality.summary)")

        let dependencyBefore = data.edges.filter { $0.kind == .imports }.count
        let dependencyAfter = pruned.edges.filter { $0.kind == .imports }.count
        if dependencyBefore > 0 {
            let kept = 100.0 * Double(dependencyAfter) / Double(dependencyBefore)
            print(String(format: "          capDegree(6) kept %d/%d import edges (%.1f%%)",
                         dependencyAfter, dependencyBefore, kept))
        }
    }

    // ── Invariants ───────────────────────────────────────────────────────────
    check(layout.positions.count == data.nodes.count, testCase.name, "every node placed",
          "placed \(layout.positions.count) of \(data.nodes.count)")

    let allFinite = layout.positions.values.allSatisfy { $0.x.isFinite && $0.y.isFinite }
    check(allFinite, testCase.name, "positions finite", "found NaN or infinite coordinates")

    // Determinism: the same input must produce the same picture, or the graph
    // changes identity between launches — one of the reported symptoms.
    let repeated = GraphLayoutEngine.layout(data)
    let identical = layout.positions.allSatisfy { id, point in
        guard let other = repeated.positions[id] else { return false }
        return abs(point.x - other.x) < 0.001 && abs(point.y - other.y) < 0.001
    }
    check(identical, testCase.name, "deterministic", "re-running produced different positions")

    // The ring artefact. A relaxed layout fills space; concentric rings do not.
    check(quality.radialConcentration < 0.20, testCase.name, "not a ring",
          String(format: "radialConcentration %.3f ≥ 0.20", quality.radialConcentration))

    // Collision resolution must actually separate nodes.
    check(quality.nodeOverlapRatio < 0.02, testCase.name, "nodes not overlapping",
          String(format: "overlapRatio %.3f ≥ 0.02", quality.nodeOverlapRatio))

    // Weight filtering must not shatter the graph the way capDegree did.
    if testCase.ownsConnectivity {
        check(quality.largestComponentShare > 0.55, testCase.name, "graph stays connected",
              String(format: "largest component holds only %.2f of nodes",
                     quality.largestComponentShare))
    } else if quality.largestComponentShare <= 0.55 {
        print(String(format: "          ⚠︎ input is fragmented: %d components, "
                     + "largest holds %.2f of nodes — a property of the producer, not the layout",
                     quality.componentCount, quality.largestComponentShare))
    }

    // Clustering should find real structure in a modular codebase.
    if testCase.name.hasPrefix("code") {
        check(quality.modularity > 0.30, testCase.name, "clusters are real",
              String(format: "modularity %.3f ≤ 0.30", quality.modularity))
    }

    // Separation is only meaningful once there is something to separate. On a
    // fully fragmented input every "cluster" is a single node with no spread,
    // so the ratio is 0 by construction — a fact about the producer's output,
    // not about the layout.
    if testCase.ownsConnectivity || quality.largestComponentShare > 0.55 {
        check(quality.clusterSeparation > 1.0, testCase.name, "clusters separated",
              String(format: "clusterSeparation %.2f ≤ 1.0", quality.clusterSeparation))
    }

    // ── SVG ──────────────────────────────────────────────────────────────────
    if let svgDirectory {
        let safeName = testCase.name.replacingOccurrences(of: "/", with: "-")
        try? FileManager.default.createDirectory(atPath: svgDirectory,
                                                 withIntermediateDirectories: true)
        let newPath = "\(svgDirectory)/\(safeName)-new.svg"
        try? SVGWriter.write(layout: layout, data: data, to: newPath,
                             title: "\(testCase.name) — new engine "
                                 + "(\(data.nodes.count) nodes, \(layout.communityCount) clusters)")
        print("          svg → \(newPath)")
        if !legacyPositions.isEmpty {
            let pruned = LegacyLayout.capDegree(data, maxDegree: 6)
            let canvas = LegacyLayout.layoutSize(nodeCount: pruned.nodes.count)
            let ringPath = "\(svgDirectory)/\(safeName)-legacy-ring.svg"
            try? SVGWriter.writePlain(positions: LegacyLayout.pieSlice(pruned, canvasSize: canvas),
                                      data: pruned, to: ringPath,
                                      title: "\(testCase.name) — legacy phase 1 (pie-slice rings)",
                                      subtitle: "what the user sees when the settle result is dropped")
            let settledPath = "\(svgDirectory)/\(safeName)-legacy-settled.svg"
            try? SVGWriter.writePlain(positions: legacyPositions, data: pruned, to: settledPath,
                                      title: "\(testCase.name) — legacy phase 2 (force-settled)",
                                      subtitle: "capDegree(6) applied; single hardcoded attractor at (600,400)")
            print("          svg → \(ringPath)")
            print("          svg → \(settledPath)")
        }
    }
}

// MARK: - Result

print("")
print(String(repeating: "═", count: 96))
if failures.isEmpty {
    print("PASS — all layout invariants hold")
    print("")
    exit(0)
}
print("FAIL — \(failures.count) check(s) failed")
for failure in failures {
    print("  ✘ [\(failure.caseName)] \(failure.check): \(failure.detail)")
}
print("")
exit(1)

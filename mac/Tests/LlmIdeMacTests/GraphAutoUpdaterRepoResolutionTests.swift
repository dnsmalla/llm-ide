import XCTest
import GraphCore
import GraphKit
@testable import LlmIdeMacLib

/// `repoToGraph` decides WHICH directory the whole knowledge pipeline runs
/// against — pick wrong and the graph, the memory artifact, and the file
/// watcher all point at the wrong tree. Also covers edge weighting and layout
/// determinism, which replaced the degree cap that used to keep a dense graph
/// renderable by deleting most of its structure.
/// `@MainActor` because `repoToGraph` is a static on a `@MainActor` class and
/// so inherits that isolation — matching how `runIfEligible` actually calls it.
@MainActor
final class GraphAutoUpdaterRepoResolutionTests: XCTestCase {

    private var root: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("gau-tests-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: root)
    }

    private func mkdir(_ rel: String) throws {
        try fm.createDirectory(at: root.appendingPathComponent(rel), withIntermediateDirectories: true)
    }

    private func touch(_ rel: String) throws {
        let url = root.appendingPathComponent(rel)
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "x".write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: - repoToGraph

    func testEmptyProjectHasNothingToGraph() {
        XCTAssertNil(GraphAutoUpdater.repoToGraph(projectRoot: root))
    }

    func testProjectRootIsGraphedWhenItDirectlyHoldsFiles() throws {
        try touch("main.swift")
        XCTAssertEqual(GraphAutoUpdater.repoToGraph(projectRoot: root)?.standardizedFileURL,
                       root.standardizedFileURL)
    }

    func testCloneIntoCodeLayoutPicksTheChildRepo() throws {
        try mkdir("code/my-app")
        XCTAssertEqual(GraphAutoUpdater.repoToGraph(projectRoot: root)?.lastPathComponent, "my-app")
    }

    /// With several clones, the one already carrying a graph wins so
    /// incremental refresh stays pinned to the same tree across launches.
    func testAlreadyGraphedChildWinsOverAlphabeticalFirst() throws {
        try mkdir("code/aaa-first")
        try touch("code/zzz-graphed/system/graph/index.md")
        XCTAssertEqual(GraphAutoUpdater.repoToGraph(projectRoot: root)?.lastPathComponent, "zzz-graphed")
    }

    func testUngraphedChildrenResolveDeterministically() throws {
        try mkdir("code/beta")
        try mkdir("code/alpha")
        XCTAssertEqual(GraphAutoUpdater.repoToGraph(projectRoot: root)?.lastPathComponent, "alpha")
    }

    /// The workspace root is never graphed when `code/` children exist — it
    /// isn't a git repo and holds the tool's own generated output.
    func testWorkspaceRootIsNeverPreferredOverACodeChild() throws {
        try touch("system/graph/index.md")     // stale graph at the workspace root
        try mkdir("code/real-repo")
        XCTAssertEqual(GraphAutoUpdater.repoToGraph(projectRoot: root)?.lastPathComponent, "real-repo")
    }

    // MARK: - Edge weighting (replaces GraphPrune.capDegree)

    /// The defect that made the Graph view structurally empty.
    ///
    /// `GraphPrune.capDegree(6)` kept edges in emission order while both
    /// endpoints were under the cap. `StructureGraphBuilder` emits every
    /// `contains` edge before the first `imports` edge, so a file with more
    /// than six symbols spent its entire budget on containment and lost all of
    /// its dependencies — measured on a real repo, 0 of 684 import edges
    /// survived. Weight-based selection must keep both.
    func testDependencyEdgesSurviveAlongsideContainmentOnASymbolHeavyFile() {
        var nodes = [CGNode(id: "file:a", title: "a.swift", kind: .file),
                     CGNode(id: "file:b", title: "b.swift", kind: .file)]
        var edges: [CGEdge] = []
        // 20 symbols in a.swift — well past the old cap of 6.
        for index in 0..<20 {
            let id = "function:a:fn\(index)"
            nodes.append(CGNode(id: id, title: "fn\(index)", kind: .function))
            edges.append(CGEdge(fromId: "file:a", toId: id, kind: .contains))
        }
        // The dependency edge, emitted last exactly as the real builder does.
        edges.append(CGEdge(fromId: "file:a", toId: "file:b", kind: .imports))

        let topology = GraphTopology(CGData(nodes: nodes, edges: edges))
        let kinds = Set(topology.links.map(\.kind))
        XCTAssertTrue(kinds.contains(.imports),
                      "the import edge must survive a file with 20 symbols")
        XCTAssertTrue(kinds.contains(.contains))
        XCTAssertEqual(topology.links.count, 21, "no edge is discarded by position")
    }

    /// Title-match noise must weigh far less than extracted structure, so a
    /// weight threshold separates them without deleting anything.
    func testTitleMatchNoiseWeighsLessThanStructure() {
        let structural = CGEdge(fromId: "a", toId: "b", kind: .imports,
                                confidence: .extracted)
        let noise = CGEdge(fromId: "a", toId: "c", kind: .relatedTo,
                           confidence: .ambiguous)
        XCTAssertGreaterThan(EdgeWeight.weight(of: structural),
                             EdgeWeight.defaultMinWeight)
        XCTAssertLessThan(EdgeWeight.weight(of: noise),
                          EdgeWeight.defaultMinWeight)
    }

    /// The same graph must lay out identically every time, or the picture
    /// changes identity between launches — half of the reported symptom.
    func testLayoutIsDeterministic() {
        var nodes: [CGNode] = []
        var edges: [CGEdge] = []
        for index in 0..<40 {
            nodes.append(CGNode(id: "n\(index)", title: "n\(index)", kind: .file))
            if index > 0 {
                edges.append(CGEdge(fromId: "n\(index - 1)", toId: "n\(index)",
                                    kind: .imports))
            }
        }
        let data = CGData(nodes: nodes, edges: edges)
        let first = GraphLayoutEngine.layout(data)
        let second = GraphLayoutEngine.layout(data)
        XCTAssertEqual(first.positions.count, nodes.count, "every node is placed")
        for (id, point) in first.positions {
            let other = try? XCTUnwrap(second.positions[id])
            XCTAssertEqual(point.x, other?.x ?? .nan, accuracy: 0.001)
            XCTAssertEqual(point.y, other?.y ?? .nan, accuracy: 0.001)
        }
    }
}

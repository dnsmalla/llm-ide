import XCTest
import GraphKit
@testable import LlmIdeMacLib

/// `repoToGraph` decides WHICH directory the whole knowledge pipeline runs
/// against — pick wrong and the graph, the memory artifact, and the file
/// watcher all point at the wrong tree. Also covers `GraphPrune`, the degree
/// cap that keeps a dense doc graph renderable.
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

    // MARK: - GraphPrune

    func testCapDegreeLeavesAGraphAlreadyWithinBudget() {
        let data = CGData(nodes: [
            CGNode(id: "a", title: "a", kind: .file),
            CGNode(id: "b", title: "b", kind: .file),
        ], edges: [CGEdge(fromId: "a", toId: "b", kind: .relatedTo)])
        XCTAssertEqual(GraphPrune.capDegree(data, maxDegree: 6).edges.count, 1)
    }

    func testCapDegreeKeepsStrongestEdgesFirst() {
        // A hub with 5 edges, capped at 2: input order is significant because
        // MemoryGenerator emits explicit references before noisy fallbacks.
        let nodes = (0..<6).map { CGNode(id: "n\($0)", title: "n\($0)", kind: .memoryChunk) }
        let edges = (1..<6).map {
            CGEdge(fromId: "n0", toId: "n\($0)", kind: $0 <= 2 ? .references : .relatedTo)
        }
        let pruned = GraphPrune.capDegree(CGData(nodes: nodes, edges: edges), maxDegree: 2)
        XCTAssertEqual(pruned.edges.count, 2)
        XCTAssertTrue(pruned.edges.allSatisfy { $0.kind == .references })
        XCTAssertEqual(pruned.nodes.count, 6, "pruning drops edges, never nodes")
    }

    func testCapDegreeIsANoOpForNonPositiveBudget() {
        let data = CGData(nodes: [CGNode(id: "a", title: "a", kind: .file)],
                          edges: [CGEdge(fromId: "a", toId: "a", kind: .relatedTo)])
        XCTAssertEqual(GraphPrune.capDegree(data, maxDegree: 0).edges.count, 1)
    }
}

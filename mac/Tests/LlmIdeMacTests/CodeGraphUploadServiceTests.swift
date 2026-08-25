import XCTest
import GraphKit
@testable import LlmIdeMacLib

/// Batching and change-detection for the code-graph upload. Both are pure and
/// carry the two properties the server contract depends on: `replace` is set on
/// exactly one batch per generation, and no node or edge is lost in the split.
final class CodeGraphUploadServiceTests: XCTestCase {

    private func nodes(_ n: Int) -> [CGNode] {
        (0..<n).map { CGNode(id: "file:f\($0).swift", title: "f\($0).swift", kind: .file) }
    }

    private func edges(_ n: Int) -> [CGEdge] {
        (0..<n).map { CGEdge(fromId: "file:f\($0).swift", toId: "file:f\($0 + 1).swift", kind: .imports) }
    }

    // MARK: - batching

    func testSmallGraphIsOneBatchThatReplaces() {
        let out = CodeGraphUploadService.batches(nodes: nodes(10), edges: edges(5))
        XCTAssertEqual(out.count, 1)
        XCTAssertTrue(out[0].replace)
        XCTAssertEqual(out[0].nodes.count, 10)
        XCTAssertEqual(out[0].edges.count, 5)
    }

    /// The critical invariant: `replace` clears the repo's previous graph, so
    /// setting it on more than the first batch would leave only the last batch.
    func testOnlyTheFirstBatchReplaces() {
        let out = CodeGraphUploadService.batches(nodes: nodes(5000), edges: edges(9000))
        XCTAssertGreaterThan(out.count, 1)
        XCTAssertEqual(out.filter(\.replace).count, 1)
        XCTAssertTrue(out[0].replace)
    }

    func testBatchingLosesNothing() {
        let allNodes = nodes(3200)
        let allEdges = edges(9500)
        let out = CodeGraphUploadService.batches(nodes: allNodes, edges: allEdges)
        XCTAssertEqual(out.flatMap(\.nodes).map(\.id), allNodes.map(\.id))
        XCTAssertEqual(out.reduce(0) { $0 + $1.edges.count }, allEdges.count)
    }

    func testNoBatchExceedsTheServerRequestCaps() {
        let out = CodeGraphUploadService.batches(nodes: nodes(9000), edges: edges(30000))
        for batch in out {
            XCTAssertLessThanOrEqual(batch.nodes.count, CodeGraphUploadService.nodesPerBatch)
            XCTAssertLessThanOrEqual(batch.edges.count, CodeGraphUploadService.edgesPerBatch)
        }
    }

    /// Lopsided graphs (many edges, few nodes) must still ship every edge —
    /// packing by node count alone would silently drop the tail.
    func testEdgeHeavyGraphStillShipsEveryEdge() {
        let out = CodeGraphUploadService.batches(nodes: nodes(3), edges: edges(12000))
        XCTAssertEqual(out.reduce(0) { $0 + $1.edges.count }, 12000)
        XCTAssertEqual(out.reduce(0) { $0 + $1.nodes.count }, 3)
    }

    func testEmptyGraphProducesASingleEmptyBatch() {
        let out = CodeGraphUploadService.batches(nodes: [], edges: [])
        XCTAssertEqual(out.count, 1)
        XCTAssertTrue(out[0].nodes.isEmpty)
        XCTAssertTrue(out[0].edges.isEmpty)
    }

    // MARK: - fingerprint

    func testIdenticalGraphsShareAFingerprint() {
        let a = CGData(nodes: nodes(50), edges: edges(20))
        let b = CGData(nodes: nodes(50), edges: edges(20))
        XCTAssertEqual(CodeGraphUploadService.fingerprint(a), CodeGraphUploadService.fingerprint(b))
    }

    func testAddedNodeChangesTheFingerprint() {
        let base = CGData(nodes: nodes(50), edges: edges(20))
        let grown = CGData(nodes: nodes(51), edges: edges(20))
        XCTAssertNotEqual(CodeGraphUploadService.fingerprint(base),
                          CodeGraphUploadService.fingerprint(grown))
    }

    func testChangedEdgeSetChangesTheFingerprint() {
        let base = CGData(nodes: nodes(10), edges: edges(5))
        let rewired = CGData(nodes: nodes(10), edges: [
            CGEdge(fromId: "file:f0.swift", toId: "file:f9.swift", kind: .imports),
        ])
        XCTAssertNotEqual(CodeGraphUploadService.fingerprint(base),
                          CodeGraphUploadService.fingerprint(rewired))
    }

    /// Node identity alone isn't enough — a renamed symbol at the same id is a
    /// real change the server should see.
    func testRenamedNodeChangesTheFingerprint() {
        let base = CGData(nodes: [CGNode(id: "s:1", title: "before", kind: .function)], edges: [])
        let renamed = CGData(nodes: [CGNode(id: "s:1", title: "after", kind: .function)], edges: [])
        XCTAssertNotEqual(CodeGraphUploadService.fingerprint(base),
                          CodeGraphUploadService.fingerprint(renamed))
    }

    /// Layout runs after generation and mutates positions; that must NOT count
    /// as a change or every layout pass would trigger a full re-upload.
    func testLayoutPositionsDoNotAffectTheFingerprint() {
        let plain = CGData(nodes: [CGNode(id: "s:1", title: "f", kind: .function)], edges: [])
        let laidOut = CGData(nodes: [CGNode(id: "s:1", title: "f", kind: .function,
                                            position: CGPoint(x: 120, y: 44))], edges: [])
        XCTAssertEqual(CodeGraphUploadService.fingerprint(plain),
                       CodeGraphUploadService.fingerprint(laidOut))
    }

    // MARK: - upload guards

    @MainActor
    func testUploadIsSkippedWithoutAnAPIClient() async {
        let service = CodeGraphUploadService()
        let did = await service.upload(graph: CGData(nodes: nodes(3), edges: []),
                                       repoRoot: URL(fileURLWithPath: "/tmp/repo"))
        XCTAssertFalse(did)
    }

    /// An empty graph must never be uploaded: `replace` would wipe a good
    /// server-side graph when a scan transiently produces nothing.
    @MainActor
    func testEmptyGraphIsNeverUploaded() async {
        let service = CodeGraphUploadService()
        let did = await service.upload(graph: .empty, repoRoot: URL(fileURLWithPath: "/tmp/repo"))
        XCTAssertFalse(did)
    }

    // MARK: - truncation selection

    func testPrepareForUploadLeavesSmallGraphsUntouched() {
        let nodes = nodes(10)
        let edges = edges(5)
        let out = CodeGraphUploadService.prepareForUpload(
            nodes: nodes, edges: edges, repoPath: "/tmp/repo", maxNodes: 100, maxEdges: 100)
        XCTAssertNil(out.truncation)
        XCTAssertEqual(out.nodes.count, 10)
        XCTAssertEqual(out.edges.count, 5)
    }

    func testPrepareForUploadPrefersEntryFilesOverTestPaths() {
        let prod = CGNode(id: "file:Sources/App/main.swift", title: "main.swift", kind: .file)
        let test = CGNode(id: "file:Tests/Generated/test_999.swift", title: "test_999.swift", kind: .file)
        let filler = (0..<5).map {
            CGNode(id: "file:Sources/Deep/Nested/f\($0).swift", title: "f\($0).swift", kind: .file)
        }
        let allNodes = filler + [test, prod]
        let allEdges = allNodes.dropLast().enumerated().map {
            CGEdge(fromId: $0.element.id, toId: allNodes[$0.offset + 1].id, kind: .imports)
        }
        let out = CodeGraphUploadService.prepareForUpload(
            nodes: allNodes, edges: Array(allEdges), repoPath: "/tmp/repo", maxNodes: 2, maxEdges: 10)
        XCTAssertNotNil(out.truncation)
        XCTAssertEqual(out.nodes.count, 2)
        XCTAssertTrue(out.nodes.contains(where: { $0.id == prod.id }))
        XCTAssertFalse(out.nodes.contains(where: { $0.id == test.id }))
    }

    func testPrepareForUploadDropsEdgesWithMissingEndpoints() {
        let n1 = CGNode(id: "file:a.swift", title: "a.swift", kind: .file)
        let n2 = CGNode(id: "file:b.swift", title: "b.swift", kind: .file)
        let n3 = CGNode(id: "file:c.swift", title: "c.swift", kind: .file)
        let edges = [
            CGEdge(fromId: n1.id, toId: n2.id, kind: .imports),
            CGEdge(fromId: n2.id, toId: n3.id, kind: .imports),
        ]
        let out = CodeGraphUploadService.prepareForUpload(
            nodes: [n1, n2, n3], edges: edges, repoPath: "/tmp/repo", maxNodes: 2, maxEdges: 10)
        XCTAssertEqual(out.nodes.count, 2)
        for edge in out.edges {
            XCTAssertTrue(out.nodes.contains(where: { $0.id == edge.fromId }))
            XCTAssertTrue(out.nodes.contains(where: { $0.id == edge.toId }))
        }
    }
}

import XCTest
import GraphKit
@testable import LlmIdeMac

final class GraphNotesRenderTests: XCTestCase {
    private func chunk(id: String, body: String,
                       graphOnly: Bool = false, kind: CGNodeKind = .memoryChunk) -> MemoryChunk {
        MemoryChunk(id: id, docURL: URL(fileURLWithPath: "/tmp/d.md"), docTitle: "d",
                    headingPath: ["S"], body: body, kind: kind,
                    tags: [], wikiLinks: [], graphOnly: graphOnly, relatedModules: [])
    }

    func testMergeAddsMentionLinkFromBacktickPath() {
        let code = CGData(nodes: [CGNode(id: "file:kb/db.mjs", title: "kb/db.mjs",
                                         kind: .file, metadata: [:])],
                          edges: [])
        let doc = CGData(nodes: [], edges: [])
        let c = chunk(id: "c1", body: "Migrations live in `kb/db.mjs`.")
        let merged = KnowledgeGraphService.merge(code: code, doc: doc, chunks: [c])
        let cross = merged.edges.filter { $0.kind == .references && $0.toId == "file:kb/db.mjs" }
        XCTAssertEqual(cross.count, 1, "backtick mention must produce a doc→code reference edge")
        XCTAssertEqual(cross.first?.fromId, "c1")
    }

    func testMergeAddsMentionLinkViaSourceFileMetadataWhenTitleDiffers() {
        // Title is a symbol name, NOT the file path — so the mention can only
        // resolve via the metadata["source_file"] inventory augmentation, not
        // codeIdsByTitle. This is the regression test for the metadata-key bug.
        let code = CGData(nodes: [CGNode(id: "file:kb/db.mjs", title: "DbModule",
                                         kind: .file, metadata: ["source_file": "kb/db.mjs"])],
                          edges: [])
        let c = chunk(id: "c1", body: "See `kb/db.mjs` for the schema.")
        let merged = KnowledgeGraphService.merge(code: code, doc: CGData(nodes: [], edges: []), chunks: [c])
        let cross = merged.edges.filter { $0.kind == .references && $0.toId == "file:kb/db.mjs" }
        XCTAssertEqual(cross.count, 1, "mention must resolve via metadata[\"source_file\"] since title doesn't match")
    }

    func testMergeStillIgnoresPlainProseWords() {
        let code = CGData(nodes: [CGNode(id: "file:server.mjs", title: "server",
                                         kind: .file, metadata: [:])],
                          edges: [])
        let c = chunk(id: "c1", body: "The server restarts nightly.")
        let merged = KnowledgeGraphService.merge(code: code, doc: CGData(nodes: [], edges: []), chunks: [c])
        XCTAssertTrue(merged.edges.filter { $0.kind == .references }.isEmpty)
    }

    func testGraphNotesRendersDependencyHubs() {
        let nodes = [
            CGNode(id: "f:a", title: "core/utils.mjs", kind: .file, metadata: [:]),
            CGNode(id: "f:b", title: "kb/router.mjs",  kind: .file, metadata: [:]),
            CGNode(id: "f:c", title: "server.mjs",     kind: .file, metadata: [:]),
        ]
        // Two files import core/utils.mjs; one imports kb/router.mjs.
        let edges = [
            CGEdge(fromId: "f:b", toId: "f:a", kind: .imports),
            CGEdge(fromId: "f:c", toId: "f:a", kind: .imports),
            CGEdge(fromId: "f:c", toId: "f:b", kind: .imports),
        ]
        let code = CGData(nodes: nodes, edges: edges)
        let out = KnowledgeGraphService.renderGraphNotes(
            code: code, doc: CGData(nodes: [], edges: []), merged: code)
        XCTAssertTrue(out.contains("## Dependency hubs"), "hubs section present")
        XCTAssertTrue(out.contains("core/utils.mjs — imported by 2"), "top hub with count")
        // Ordering: the 2-importer hub must appear before the 1-importer hub.
        let a = out.range(of: "core/utils.mjs — imported by 2")!.lowerBound
        let b = out.range(of: "kb/router.mjs — imported by 1")!.lowerBound
        XCTAssertLessThan(a, b)
    }
}

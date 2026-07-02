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
        // Title is a symbol name ("backupTo"), NOT the file path — matching how
        // StructureGraphBuilder actually titles symbol/function nodes (title =
        // sym.name), unlike .file nodes whose title is always the path's
        // basename and therefore always matches metadata["source_file"]. So the
        // mention can only resolve via the metadata["source_file"] inventory
        // augmentation, not codeIdsByTitle. Regression test for the metadata-key
        // bug, using a fixture shape that actually occurs in the real pipeline.
        let code = CGData(nodes: [CGNode(id: "function:kb/db.mjs:backupTo", title: "backupTo",
                                         kind: .function, metadata: ["source_file": "kb/db.mjs"])],
                          edges: [])
        let c = chunk(id: "c1", body: "See `kb/db.mjs` for the schema.")
        let merged = KnowledgeGraphService.merge(code: code, doc: CGData(nodes: [], edges: []), chunks: [c])
        let cross = merged.edges.filter { $0.kind == .references && $0.toId == "function:kb/db.mjs:backupTo" }
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
            code: code, doc: CGData(nodes: [], edges: []), merged: code, chunks: [])
        XCTAssertTrue(out.contains("## Dependency hubs"), "hubs section present")
        XCTAssertTrue(out.contains("core/utils.mjs — imported by 2"), "top hub with count")
        // Ordering: the 2-importer hub must appear before the 1-importer hub.
        let a = out.range(of: "core/utils.mjs — imported by 2")!.lowerBound
        let b = out.range(of: "kb/router.mjs — imported by 1")!.lowerBound
        XCTAssertLessThan(a, b)
    }

    func testGraphNotesExcludesGraphOnlyChunkMentions() {
        let code = CGData(nodes: [CGNode(id: "file:kb/secret.mjs", title: "kb/secret.mjs",
                                         kind: .file, metadata: [:])],
                          edges: [])
        // A graph-only chunk mentions a code file via backtick — this edge
        // exists in `merged` (DocCodeLinker adds it unconditionally), but
        // graph-notes.md must not surface it, matching doc-notes.md's own
        // graph-only exclusion.
        let secretChunk = chunk(id: "doc:secret::0", body: "See `kb/secret.mjs` for internals.",
                                graphOnly: true)
        let visibleChunk = chunk(id: "doc:visible::0", body: "no code mention here")
        let doc = CGData(nodes: [
            CGNode(id: "doc:secret::0", title: "Internal Notes", kind: .memoryChunk, metadata: [:]),
            CGNode(id: "doc:visible::0", title: "Public Notes", kind: .memoryChunk, metadata: [:]),
        ], edges: [])
        let merged = KnowledgeGraphService.merge(code: code, doc: doc, chunks: [secretChunk, visibleChunk])
        let out = KnowledgeGraphService.renderGraphNotes(code: code, doc: doc, merged: merged,
                                                         chunks: [secretChunk, visibleChunk])
        XCTAssertFalse(out.contains("Internal Notes"), "graph-only chunk's title must not appear in graph-notes.md")
        XCTAssertFalse(out.contains("kb/secret.mjs"), "graph-only chunk's code mention must not leak")
    }

    func testDocNotesExcludesGraphOnlyAndMeetingChunks() {
        let keep = chunk(id: "c1", body: "arch")
        let graphOnly = chunk(id: "c2", body: "spec detail", graphOnly: true)
        let meeting = chunk(id: "c3", body: "standup", kind: .noteEvent)
        let out = KnowledgeGraphService.renderDocNotes(docCount: 1,
                                                       chunks: [keep, graphOnly, meeting])
        XCTAssertTrue(out.contains("1 section"), "only the memory-eligible chunk is counted")
        XCTAssertFalse(out.contains("2 sections") || out.contains("3 sections"))
    }

    func testDocNotesRendersModuleAffinity() {
        let c = MemoryChunk(id: "c1", docURL: URL(fileURLWithPath: "/tmp/adr.md"),
                            docTitle: "adr-0003-auth", headingPath: ["Decision"],
                            body: "b", kind: .noteDecision, tags: [], wikiLinks: [],
                            graphOnly: false, relatedModules: ["server/auth.mjs"])
        let out = KnowledgeGraphService.renderDocNotes(docCount: 1, chunks: [c])
        XCTAssertTrue(out.contains("## Doc ↔ module affinity"))
        XCTAssertTrue(out.contains("adr-0003-auth → server/auth.mjs"))
    }
}

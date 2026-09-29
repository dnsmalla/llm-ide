import XCTest
import GraphCore
@testable import LlmIdeMacLib

/// Doc→code citation edges must reach the backend upload (so find-code can
/// say "documented by") while every graph view keeps rendering a code graph
/// with no `.docPage` node. Before the overlay, `strippingDocNodes` deleted
/// every doc node and every edge touching one before the upload ever ran.
///
/// The raw graph is constructed here directly: the Mac build resolves
/// graph-kit from its pinned revision, so this must not depend on graph-kit's
/// own citation extraction.
@MainActor
final class CodeGraphCitationUploadTests: XCTestCase {

    /// What a raw scan of a repo with one cited doc looks like: a doc FILE node
    /// with a heading it contains, a `references` edge to a symbol and to a
    /// file, a doc→doc link, and ordinary code structure.
    nonisolated static func rawGraph() -> CGData {
        CGData(nodes: [
            CGNode(id: "file:docs/guide.md", title: "guide.md", kind: .docPage,
                   metadata: ["source_file": "docs/guide.md"]),
            CGNode(id: "heading:docs/guide.md:Storage", title: "Storage", kind: .docPage,
                   metadata: ["source_file": "docs/guide.md"]),
            CGNode(id: "file:docs/other.md", title: "other.md", kind: .docPage,
                   metadata: ["source_file": "docs/other.md"]),
            CGNode(id: "file:kb/db.mjs", title: "db.mjs", kind: .file,
                   metadata: ["source_file": "kb/db.mjs"]),
            CGNode(id: "function:kb/db.mjs:backupTo", title: "backupTo", kind: .function,
                   metadata: ["source_file": "kb/db.mjs", "line": "L3"]),
        ], edges: [
            CGEdge(fromId: "file:docs/guide.md", toId: "heading:docs/guide.md:Storage", kind: .contains),
            CGEdge(fromId: "file:kb/db.mjs", toId: "function:kb/db.mjs:backupTo", kind: .contains),
            CGEdge(fromId: "file:docs/guide.md", toId: "function:kb/db.mjs:backupTo",
                   kind: .references, confidence: .inferred),
            CGEdge(fromId: "file:docs/guide.md", toId: "file:kb/db.mjs",
                   kind: .references, confidence: .extracted),
            CGEdge(fromId: "file:docs/guide.md", toId: "file:docs/other.md",
                   kind: .references, confidence: .extracted),
        ])
    }

    /// Mirrors `BuiltinGraphEngine`: strips the doc nodes from the scan it
    /// returns and hands the citation overlay back separately.
    final class StrippingEngine: GraphEngine, @unchecked Sendable {
        var raw = CodeGraphCitationUploadTests.rawGraph()
        var identifier: String { "stripping" }
        var displayName: String { "Stripping" }
        var supportedDocExtensions: Set<String> { [] }
        func scanCode(repoRoot: URL) async throws -> CodeScan {
            try await scanCodeWithCitations(repoRoot: repoRoot).scan
        }
        func scanCodeWithCitations(repoRoot: URL) async throws -> (scan: CodeScan, citations: CGData) {
            (CodeScan(graph: FileClassifier.strippingDocNodes(from: raw), scan: .empty,
                      reportsSymbols: false),
             FileClassifier.citationOverlay(from: raw))
        }
        func generateDocMemory(roots: [URL]) async throws -> GeneratedMemory { .empty }
        func generateDocMemory(files: [URL]) async throws -> GeneratedMemory { .empty }
        func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) async throws -> CGData { code }
        func docSetFingerprint(roots: [URL]) -> String { "" }
    }

    /// An engine that leaves its doc nodes in the scan (as a plugin may) and
    /// relies on the protocol's default `scanCodeWithCitations`.
    final class RawEngine: GraphEngine, @unchecked Sendable {
        var identifier: String { "raw" }
        var displayName: String { "Raw" }
        var supportedDocExtensions: Set<String> { [] }
        func scanCode(repoRoot: URL) async throws -> CodeScan {
            CodeScan(graph: CodeGraphCitationUploadTests.rawGraph(), scan: .empty, reportsSymbols: false)
        }
        func generateDocMemory(roots: [URL]) async throws -> GeneratedMemory { .empty }
        func generateDocMemory(files: [URL]) async throws -> GeneratedMemory { .empty }
        func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) async throws -> CGData { code }
        func docSetFingerprint(roots: [URL]) -> String { "" }
    }

    private var repo: URL!

    override func setUpWithError() throws {
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("cg-citations-\(UUID().uuidString)").standardizedFileURL
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: repo)
    }

    private func assertUploadCarriesCitations(engine: GraphEngine,
                                              file: StaticString = #filePath, line: UInt = #line) async {
        let service = KnowledgeGraphService(engine: engine)
        await service.generate(codeRepoRoot: repo, docRoots: [])

        // Rendered: no doc node of any kind, no doc edge.
        XCTAssertFalse(service.codeGraph.nodes.contains { $0.kind == .docPage },
                       "the rendered code graph must stay free of .docPage nodes", file: file, line: line)
        XCTAssertFalse(service.codeGraph.edges.contains { $0.kind == .references }, file: file, line: line)

        // Upload payload: the doc FILE node and its citations into code.
        let payload = service.codeGraphForUpload
        XCTAssertTrue(payload.nodes.contains { $0.id == "file:docs/guide.md" && $0.kind == .docPage },
                      file: file, line: line)
        XCTAssertTrue(payload.edges.contains {
            $0.fromId == "file:docs/guide.md" && $0.toId == "function:kb/db.mjs:backupTo"
                && $0.kind == .references && $0.confidence == .inferred
        }, "the doc→symbol citation must be uploaded", file: file, line: line)
        XCTAssertTrue(payload.edges.contains {
            $0.fromId == "file:docs/guide.md" && $0.toId == "file:kb/db.mjs" && $0.kind == .references
        }, file: file, line: line)
        // Headings stay stripped everywhere; a doc→doc link has no code target.
        XCTAssertFalse(payload.nodes.contains { $0.id.hasPrefix("heading:") }, file: file, line: line)
        XCTAssertFalse(payload.nodes.contains { $0.id == "file:docs/other.md" }, file: file, line: line)
        XCTAssertFalse(payload.edges.contains { $0.toId == "file:docs/other.md" }, file: file, line: line)
        // Every payload edge resolves to a payload node.
        let ids = Set(payload.nodes.map(\.id))
        XCTAssertTrue(payload.edges.allSatisfy { ids.contains($0.fromId) && ids.contains($0.toId) },
                      file: file, line: line)
    }

    func testBuiltinStyleEngineUploadsCitationsButRendersNoDocNodes() async {
        await assertUploadCarriesCitations(engine: StrippingEngine())
    }

    func testEngineThatLeavesDocNodesInGetsTheSameOverlayByDefault() async {
        await assertUploadCarriesCitations(engine: RawEngine())
    }

    /// The upload dedupes on fingerprint@HEAD. The fingerprint is taken over
    /// the payload, so a doc-only change (a new citation) moves it and the
    /// next tick re-uploads.
    func testUploadFingerprintMovesOnADocOnlyChange() async {
        let engine = StrippingEngine()
        let service = KnowledgeGraphService(engine: engine)
        await service.generate(codeRepoRoot: repo, docRoots: [])
        let before = CodeGraphUploadService.fingerprint(service.codeGraphForUpload)
        XCTAssertNotEqual(before, CodeGraphUploadService.fingerprint(service.codeGraph),
                          "the overlay must be part of what is fingerprinted")

        engine.raw = CGData(nodes: engine.raw.nodes,
                            edges: engine.raw.edges.filter { $0.toId != "file:kb/db.mjs" || $0.kind != .references })
        await service.generate(codeRepoRoot: repo, docRoots: [])
        XCTAssertEqual(CodeGraphUploadService.fingerprint(service.codeGraph),
                       CodeGraphUploadService.fingerprint(FileClassifier.strippingDocNodes(from: engine.raw)))
        XCTAssertNotEqual(CodeGraphUploadService.fingerprint(service.codeGraphForUpload), before,
                          "dropping one citation must re-upload")
    }

    func testNoCitationsLeavesTheUploadEqualToTheCodeGraph() {
        let code = FileClassifier.strippingDocNodes(from: Self.rawGraph())
        XCTAssertEqual(FileClassifier.mergingCitationOverlay(.empty, into: code).nodes.map(\.id),
                       code.nodes.map(\.id))
        let noRefs = CGData(nodes: Self.rawGraph().nodes,
                            edges: Self.rawGraph().edges.filter { $0.kind != .references })
        XCTAssertTrue(FileClassifier.citationOverlay(from: noRefs).nodes.isEmpty)
    }
}

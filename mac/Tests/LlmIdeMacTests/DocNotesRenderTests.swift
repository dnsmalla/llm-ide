import XCTest
import GraphKit
@testable import LlmIdeMac

/// renderDocNotes turns the doc index into the markdown that becomes
/// graphify-out/memory/doc-notes.md — the doc half of the combined memory.
final class DocNotesRenderTests: XCTestCase {
    func testRenderDocNotesGroupsChunksByDocAndListsHeadings() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("docnotes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let md = dir.appendingPathComponent("Guide.md")
        try "# Setup\nInstall it.\n\n# Usage\nRun it.\n".write(to: md, atomically: true, encoding: .utf8)

        // Build real chunks via MemoryGenerator (MemoryChunk has no public init).
        let mem = MemoryGenerator.generate(files: [md])
        let out = KnowledgeGraphService.renderDocNotes(docCount: mem.docCount, chunks: mem.chunks)

        XCTAssertTrue(out.contains("Guide"), "doc title should appear")
        XCTAssertTrue(out.contains("Setup"), "heading should appear")
        XCTAssertTrue(out.contains("Usage"), "heading should appear")
    }

    func testWriteMemoryArtifactWritesDocNotes() throws {
        let repoRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("memart-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repoRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repoRoot) }
        let md = repoRoot.appendingPathComponent("Guide.md")
        try "# Setup\nInstall it.\n".write(to: md, atomically: true, encoding: .utf8)
        let mem = MemoryGenerator.generate(files: [md])

        KnowledgeGraphService.writeMemoryArtifact(
            to: repoRoot, code: .empty, doc: mem.graph, merged: mem.graph,
            docCount: mem.docCount, chunks: mem.chunks)

        let docNotes = repoRoot
            .appendingPathComponent("graphify-out/memory/doc-notes.md")
        let content = try String(contentsOf: docNotes, encoding: .utf8)
        XCTAssertTrue(content.contains("Guide"), "doc-notes.md should contain doc content")
        XCTAssertTrue(content.contains("Setup"))
    }
}

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
}

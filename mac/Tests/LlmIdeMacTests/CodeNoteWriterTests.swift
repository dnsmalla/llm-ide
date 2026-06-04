import Testing
import Foundation
@testable import LlmIdeMac

struct CodeNoteWriterTests {
    private func sampleNote() -> CodeNote {
        CodeNote(
            id: "file:src/a.ts",
            kind: "file",
            title: "a.ts",
            path: "src/a.ts",
            language: "typescript",
            complexity: "moderate",
            tags: ["api", "core"],
            contentHash: "abc123",
            symbols: [CodeNote.SymbolRef(name: "foo", kind: "function", line: 5)],
            links: [CodeNote.Link(to: "file:src/b.ts", kind: "imports")],
            body: "## Summary\nDoes a thing.\n"
        )
    }

    @Test func roundTripsThroughMarkdown() throws {
        let note = sampleNote()
        let md = try CodeNoteWriter.render(note)
        let parsed = try CodeNoteWriter.parse(md)
        #expect(parsed.id == note.id)
        #expect(parsed.kind == note.kind)
        #expect(parsed.tags == note.tags)
        #expect(parsed.contentHash == note.contentHash)
        #expect(parsed.links.first?.to == "file:src/b.ts")
        #expect(parsed.links.first?.kind == "imports")
        #expect(parsed.symbols.first?.name == "foo")
        #expect(parsed.body.contains("Does a thing."))
    }

    @Test func renderedMarkdownStartsWithFrontmatter() throws {
        let md = try CodeNoteWriter.render(sampleNote())
        #expect(md.hasPrefix("---\n"))
        #expect(md.contains("\nid: file:src/a.ts"))
    }

    @Test func parseRejectsMissingFrontmatter() {
        #expect(throws: CodeNoteError.self) {
            try CodeNoteWriter.parse("no frontmatter here")
        }
    }

    @Test func writeThenReadFromDisk() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("codenote-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("a.md")
        try CodeNoteWriter.write(sampleNote(), to: url)
        let loaded = try CodeNoteWriter.read(from: url)
        #expect(loaded.id == "file:src/a.ts")
    }
}

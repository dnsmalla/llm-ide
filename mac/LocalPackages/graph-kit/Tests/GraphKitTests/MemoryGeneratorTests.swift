import XCTest
@testable import GraphKit

final class MemoryGeneratorTests: XCTestCase {
    func testGeneratesChunksFromMarkdownHeadings() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-memtest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let md = """
        # Title
        Intro text.

        ## Section A
        Body A with a [[Section B]] link.

        ## Section B
        Body B.
        """
        let file = tmp.appendingPathComponent("doc.md")
        try md.write(to: file, atomically: true, encoding: .utf8)

        let result = MemoryGenerator.generate(files: [file])
        XCTAssertGreaterThan(result.chunks.count, 0, "should chunk by heading")
        XCTAssertGreaterThan(result.graph.nodes.count, 0, "should produce graph nodes")
    }

    /// The repo walker must skip generated-knowledge output (the indexer's own
    /// `system/graph`, `graphify-out`, `.code-notes`, …) and vendor dirs —
    /// otherwise the doc graph double-counts content and fills with duplicates.
    func testRepoWalkerSkipsGeneratedDirs() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-skip-\(UUID().uuidString)")
        let fm = FileManager.default
        defer { try? fm.removeItem(at: tmp) }

        func write(_ rel: String, _ body: String) throws {
            let url = tmp.appendingPathComponent(rel)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
        try write("README.md", "# Real Doc\nKept.")
        try write("system/graph/index.md", "# Module (69 files)\nGenerated, must be skipped.")
        try write("graphify-out/memory/repo.md", "# Module (69 files)\nGenerated, must be skipped.")
        try write("node_modules/pkg/readme.md", "# Vendor\nSkipped.")

        let result = MemoryGenerator.generate(from: tmp)
        let titles = Set(result.graph.nodes.map { $0.title })
        XCTAssertEqual(result.docCount, 1, "only the real doc should be indexed")
        XCTAssertTrue(titles.contains("Real Doc"))
        XCTAssertFalse(titles.contains("Module (69 files)"), "generated dirs must be skipped")
    }

    /// Agent skill frontmatter often has unquoted colons inside `description:`
    /// (e.g. `Triggers: "…"`) and nested `schema:` blocks. Parsing must not
    /// call Yams in a way that traps the host process.
    func testParseFrontmatterToleratesSkillDescriptionColons() {
        let md = """
        ---
        name: use-memory
        description: Read and write memory. Triggers: "what do we know", start of any task.
        ---

        # Body
        """
        let parsed = MemoryGenerator.parseFrontmatter(md)
        XCTAssertTrue(parsed.text.hasPrefix("# Body"))
        XCTAssertEqual(parsed.tags, [])
    }

    /// These three shapes make `Yams.load` force-unwrap nil at
    /// Constructor.swift:435 (`String.construct(from: $0.key)!`) when a nested
    /// mapping has a non-scalar key. That is a trap, not a thrown error, so
    /// `try?` cannot contain it and the host process dies. Parsing must survive.
    func testParseFrontmatterSurvivesNonScalarMappingKeys() {
        let traps = [
            "---\nschema:\n  [a, b]: c\n---\n\n# Body",
            "---\nschema:\n  {x: y}: z\n---\n\n# Body",
            "---\nschema:\n  ?\n  : c\n---\n\n# Body",
        ]
        for md in traps {
            let parsed = MemoryGenerator.parseFrontmatter(md)
            XCTAssertTrue(parsed.text.hasPrefix("# Body"), "body lost for: \(md)")
            XCTAssertEqual(parsed.tags, [])
        }
    }

    /// Yams handed `tags:` back as a real array for flow/block sequences; the
    /// line parser only produces strings, so sequence tokenization has to be
    /// done by hand. All four spellings must land on the same tags.
    func testParseFrontmatterTagSequenceForms() {
        let forms = [
            "tags: [Memory, agent]",
            "tags: [\"memory\", 'Agent']",
            "tags:\n  - memory\n  - Agent",
            "tags: memory, agent",
            "tags: [#memory, #agent]",
        ]
        for form in forms {
            let parsed = MemoryGenerator.parseFrontmatter("---\n\(form)\n---\n\n# Body")
            XCTAssertEqual(parsed.tags, ["memory", "agent"], "wrong tags for: \(form)")
        }
    }

    func testParseFrontmatterRelatedModulesPreservesCaseAndSequences() {
        let parsed = MemoryGenerator.parseFrontmatter(
            "---\nrelated-modules: [Sources/Foo.swift, Sources/Bar.swift]\n---\n\n# Body")
        XCTAssertEqual(parsed.relatedModules, ["Sources/Foo.swift", "Sources/Bar.swift"])
    }

    func testParseFrontmatterGraphOnlyAcceptsQuotedBool() {
        XCTAssertTrue(MemoryGenerator.parseFrontmatter("---\ngraph-only: \"true\"\n---\n\n# B").graphOnly)
        XCTAssertTrue(MemoryGenerator.parseFrontmatter("---\ngraphOnly: yes\n---\n\n# B").graphOnly)
        XCTAssertFalse(MemoryGenerator.parseFrontmatter("---\ngraph-only: false\n---\n\n# B").graphOnly)
    }
}

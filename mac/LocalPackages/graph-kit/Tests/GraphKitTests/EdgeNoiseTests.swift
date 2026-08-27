import XCTest
@testable import GraphKit

final class EdgeNoiseTests: XCTestCase {
    private func writeTempDocs(_ docs: [String: String]) throws -> [URL] {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-noise-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return try docs.sorted { $0.key < $1.key }.map { name, content in
            let url = dir.appendingPathComponent(name)
            try content.write(to: url, atomically: true, encoding: .utf8)
            return url
        }
    }

    func testSingleWordTitleNoLongerFallbackMatches() throws {
        let urls = try writeTempDocs([
            "a.md": "## Configuration\nsome body text",
            "b.md": "## Other\nwe changed the configuration yesterday",
        ])
        let mem = MemoryGenerator.generate(files: urls)
        let related = mem.graph.edges.filter { $0.kind == .relatedTo }
        // Only the chunk→doc containment edges remain (one per chunk);
        // no cross-chunk edge from b's body mentioning "configuration".
        let crossChunk = related.filter { $0.fromId.contains("::") && $0.toId.contains("::") }
        XCTAssertTrue(crossChunk.isEmpty, "single-word title must not create fallback edges")
    }

    func testTwoWordTitleStillFallbackMatches() throws {
        let urls = try writeTempDocs([
            "a.md": "## Auth Flow\nsome body text",
            "b.md": "## Other\nthe auth flow rotates tokens on use",
        ])
        let mem = MemoryGenerator.generate(files: urls)
        let crossChunk = mem.graph.edges.filter {
            $0.kind == .relatedTo && $0.fromId.contains("::") && $0.toId.contains("::")
        }
        XCTAssertEqual(crossChunk.count, 1, "multi-word titles remain linkable")
    }

    func testGenericTagSkippedEntirely() throws {
        // 13 docs sharing #api — over the 12-chunk generic threshold.
        var docs: [String: String] = [:]
        for i in 0..<13 { docs["t\(String(format: "%02d", i)).md"] = "## S\(i)\nbody #api" }
        let urls = try writeTempDocs(docs)
        let mem = MemoryGenerator.generate(files: urls)
        let crossChunk = mem.graph.edges.filter {
            $0.kind == .relatedTo && $0.fromId.contains("::") && $0.toId.contains("::")
        }
        XCTAssertTrue(crossChunk.isEmpty, "a tag on >12 chunks is too generic to relate them")
    }

    func testRareTagStillLinks() throws {
        let urls = try writeTempDocs([
            "a.md": "## A\nbody #vault-rotation",
            "b.md": "## B\nbody #vault-rotation",
        ])
        let mem = MemoryGenerator.generate(files: urls)
        let crossChunk = mem.graph.edges.filter {
            $0.kind == .relatedTo && $0.fromId.contains("::") && $0.toId.contains("::")
        }
        XCTAssertEqual(crossChunk.count, 1)
    }
}

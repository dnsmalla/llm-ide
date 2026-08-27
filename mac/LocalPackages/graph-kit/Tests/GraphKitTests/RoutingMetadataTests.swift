import XCTest
@testable import GraphKit

final class RoutingMetadataTests: XCTestCase {
    private func writeTempDoc(_ content: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-route-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("doc.md")
        try content.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func testGraphOnlyFrontmatterMarksAllChunks() throws {
        let url = try writeTempDoc("""
        ---
        graph-only: true
        ---
        ## A
        body a
        ## B
        body b
        """)
        let mem = MemoryGenerator.generate(files: [url])
        XCTAssertTrue(mem.chunks.allSatisfy(\.graphOnly))
    }

    func testRelatedModulesParsedVerbatim() throws {
        let url = try writeTempDoc("""
        ---
        related-modules: [kb/db.mjs, server/Auth.swift]
        ---
        ## A
        body
        """)
        let mem = MemoryGenerator.generate(files: [url])
        XCTAssertEqual(mem.chunks[0].relatedModules, ["kb/db.mjs", "server/Auth.swift"],
                       "module paths keep their case — they are paths, not tags")
    }

    func testDefaultsWhenAbsent() throws {
        let url = try writeTempDoc("## A\nbody")
        let mem = MemoryGenerator.generate(files: [url])
        XCTAssertFalse(mem.chunks[0].graphOnly)
        XCTAssertEqual(mem.chunks[0].relatedModules, [])
    }
}

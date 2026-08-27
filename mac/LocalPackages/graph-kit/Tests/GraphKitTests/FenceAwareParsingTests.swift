import XCTest
@testable import GraphKit

final class FenceAwareParsingTests: XCTestCase {
    private func writeTempDoc(_ content: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-fence-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("doc.md")
        try content.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func testHeadingInsideFenceDoesNotSplitChunks() throws {
        let url = try writeTempDoc("""
        ## Real Section
        before fence
        ```bash
        # this is a shell comment, not a heading
        echo hi
        ```
        after fence
        """)
        let mem = MemoryGenerator.generate(files: [url])
        XCTAssertEqual(mem.chunks.count, 1, "fenced '# comment' must not start a new chunk")
        XCTAssertEqual(mem.chunks[0].headingPath, ["Real Section"])
        XCTAssertTrue(mem.chunks[0].body.contains("echo hi"), "body keeps fence content")
    }

    func testHashtagsInsideFenceIgnoredOutsideKept() throws {
        let url = try writeTempDoc("""
        ## S
        real #realtag here
        ```c
        #include <stdio.h>
        ```
        """)
        let mem = MemoryGenerator.generate(files: [url])
        XCTAssertEqual(mem.chunks[0].tags, ["realtag"])
    }

    func testWikilinksInsideFenceIgnored() throws {
        let url = try writeTempDoc("""
        ## S
        ```md
        [[Fenced Target]]
        ```
        real link: [[Real Target]]
        """)
        let mem = MemoryGenerator.generate(files: [url])
        XCTAssertEqual(mem.chunks[0].wikiLinks, ["Real Target"])
    }

    func testStrippingFencedBlocksHelper() {
        let s = "keep\n```\ndrop me\n```\nkeep too"
        XCTAssertEqual(MemoryGenerator.strippingFencedBlocks(s), "keep\nkeep too")
    }
}

import XCTest
@testable import GraphKit

final class DocCodeLinkerTests: XCTestCase {
    private func chunk(id: String, body: String) -> MemoryChunk {
        MemoryChunk(id: id, docURL: URL(fileURLWithPath: "/tmp/d.md"), docTitle: "d",
                    headingPath: ["S"], body: body, kind: .memoryChunk,
                    tags: [], wikiLinks: [])
    }

    func testBacktickPathMentionLinksToFileNode() {
        let c = chunk(id: "c1", body: "Migrations live in `kb/db.mjs` next to the router.")
        let links = DocCodeLinker.links(
            chunks: [c],
            inventory: ["kb/db.mjs": ["file:kb/db.mjs"]])
        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links[0].codeNodeID, "file:kb/db.mjs")
        XCTAssertEqual(links[0].confidence, 0.9, accuracy: 0.001, "path-shaped mention")
    }

    func testBacktickSymbolMentionLinks() {
        let c = chunk(id: "c1", body: "Call `backupTo` before shutdown.")
        let links = DocCodeLinker.links(
            chunks: [c],
            inventory: ["backupto": ["sym:kb/db.mjs#backupTo"]])
        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links[0].confidence, 0.7, accuracy: 0.001, "symbol-shaped mention")
    }

    func testPlainProseWordDoesNotLink() {
        // "server" appears as a plain word, not backticked — no link even
        // though the inventory has a node named server.
        let c = chunk(id: "c1", body: "The server restarts nightly.")
        let links = DocCodeLinker.links(chunks: [c], inventory: ["server": ["file:server.mjs"]])
        XCTAssertTrue(links.isEmpty)
    }

    func testFencedCodeMentionsDoNotLink() {
        let c = chunk(id: "c1", body: "```js\nimport db from 'kb/db.mjs'\n```")
        let links = DocCodeLinker.links(chunks: [c], inventory: ["kb/db.mjs": ["file:kb/db.mjs"]])
        XCTAssertTrue(links.isEmpty, "fenced code is not a doc mention")
    }

    func testMentionWithSpacesRejected() {
        let c = chunk(id: "c1", body: "see `not a symbol name` here")
        let links = DocCodeLinker.links(chunks: [c], inventory: ["not a symbol name": ["x"]])
        XCTAssertTrue(links.isEmpty, "spans with spaces are prose, not identifiers")
    }

    func testDedupesRepeatedMentions() {
        let c = chunk(id: "c1", body: "`kb/db.mjs` and again `kb/db.mjs`")
        let links = DocCodeLinker.links(chunks: [c], inventory: ["kb/db.mjs": ["file:kb/db.mjs"]])
        XCTAssertEqual(links.count, 1)
    }
}

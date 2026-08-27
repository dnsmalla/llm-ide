import XCTest
@testable import GraphKit

/// Conformance tests for the canonical GraphDocument JSON contract. These load the
/// shared fixtures under `schema/fixtures/` — the SAME files the TypeScript binding
/// validates — so both implementations are pinned to one schema.
final class GraphDocumentCodableTests: XCTestCase {

    /// Resolve `schema/fixtures/` relative to this source file's location in the repo.
    private func fixturesDir() -> URL {
        URL(fileURLWithPath: #filePath)            // .../Tests/GraphKitTests/<thisfile>
            .deletingLastPathComponent()           // .../Tests/GraphKitTests
            .deletingLastPathComponent()           // .../Tests
            .deletingLastPathComponent()           // repo root
            .appendingPathComponent("schema/fixtures", isDirectory: true)
    }

    func testDecodesSharedSampleFixture() throws {
        let url = fixturesDir().appendingPathComponent("sample.json")
        let data = try Data(contentsOf: url)
        let doc = try GraphDocument.decode(data)

        XCTAssertEqual(doc.schemaVersion, 1)
        XCTAssertEqual(doc.nodes.count, 3)
        XCTAssertEqual(doc.edges.count, 2)
        XCTAssertEqual(doc.nodes.first?.kind, .file)
        XCTAssertEqual(doc.nodes.first?.metadata["language"], "typescript")
        XCTAssertTrue(doc.edges.contains { $0.kind == .contains && $0.confidence == .extracted })
    }

    func testRoundTripIsStable() throws {
        let url = fixturesDir().appendingPathComponent("sample.json")
        let original = try GraphDocument.decode(try Data(contentsOf: url))

        let encoded = try original.jsonData()
        let reDecoded = try GraphDocument.decode(encoded)

        XCTAssertEqual(original, reDecoded, "decode → encode → decode must be lossless")
    }

    func testMemoryFixtureRoundTripsAndOmitsZeroPositions() throws {
        let url = fixturesDir().appendingPathComponent("memory.json")
        let doc = try GraphDocument.decode(try Data(contentsOf: url))
        XCTAssertEqual(doc.nodes.count, 3)

        let encoded = String(decoding: try doc.jsonData(), as: UTF8.self)
        XCTAssertFalse(encoded.contains("\"position\""),
                       "zero-position memory nodes must omit position: \(encoded)")
        XCTAssertEqual(try GraphDocument.decode(Data(encoded.utf8)), doc)
    }

    func testNodePositionSerializesAsXYObject() throws {
        let node = CGNode(id: "n1", title: "N", kind: .file,
                          position: CGPoint(x: 3, y: 4), metadata: ["k": "v"])
        let data = try GraphDocument(CGData(nodes: [node], edges: [])).jsonData()
        let json = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(json.contains("\"x\" : 3"), "position must encode as {x,y}: \(json)")
        XCTAssertTrue(json.contains("\"y\" : 4"))
    }

    func testRejectsFutureSchemaVersion() throws {
        let future = #"{"schemaVersion": 9999, "nodes": [], "edges": []}"#
        XCTAssertThrowsError(try GraphDocument.decode(Data(future.utf8))) { err in
            XCTAssertEqual(err as? GraphDocumentError, .unsupportedSchemaVersion(9999))
        }
    }
}

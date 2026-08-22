import XCTest
@testable import LlmIdeMacLib

/// Decoding is the entire risk surface for these two calls — the request side
/// is three fields. A lenient decoder matters more than usual here because the
/// server's `failures` array is new and an older server omits it.
final class McpConnectorDecodingTests: XCTestCase {
    func testFetchResultDecodesTheFullShape() throws {
        let json = """
        {"items":[{"id":"miro:b1:i1",
                   "fields":{"Title":"Alpha — sticky_note","Board":"Alpha","Date":"2026-08-01T00:00:00.000Z"},
                   "body":"ship it"}],
         "drained":true,"skipped":{"overCap":2},"failures":["Locked: board is private"]}
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(LlmIdeAPIClient.McpFetchResult.self, from: json)
        XCTAssertEqual(r.items.count, 1)
        XCTAssertEqual(r.items[0].id, "miro:b1:i1")
        XCTAssertEqual(r.items[0].fields["Board"], "Alpha")
        XCTAssertEqual(r.items[0].body, "ship it")
        XCTAssertTrue(r.drained)
        XCTAssertEqual(r.skipped.overCap, 2)
        XCTAssertEqual(r.failures, ["Locked: board is private"])
    }

    func testFetchResultToleratesAnAbsentFailuresArray() throws {
        let json = """
        {"items":[],"drained":true,"skipped":{"overCap":0}}
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(LlmIdeAPIClient.McpFetchResult.self, from: json)
        XCTAssertEqual(r.failures, [], "a missing failures array must not fail the whole fetch")
    }

    /// The server puts the dedup key BESIDE the field map, never inside it —
    /// `ItemId` is deliberately not one of the server's fields. The manifests
    /// nevertheless declare an `ItemId -> $ItemId` raw header, so something
    /// downstream has to bridge the two; pinning the wire shape here is what
    /// makes `McpConnectorAdapter`'s injection a contract rather than a habit.
    func testItemIdIsASiblingOfFieldsNotAMember() throws {
        let json = """
        {"items":[{"id":"miro:b1:i1","fields":{"Board":"Alpha"},"body":"one"}],
         "drained":false,"skipped":{"overCap":1},"failures":[]}
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(LlmIdeAPIClient.McpFetchResult.self, from: json)
        XCTAssertEqual(r.items[0].id, "miro:b1:i1")
        XCTAssertNil(r.items[0].fields["ItemId"],
                     "the server does not send ItemId as a field — the adapter injects it")
        XCTAssertFalse(r.drained)
        XCTAssertEqual(r.skipped.overCap, 1)
    }
}

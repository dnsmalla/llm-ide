import XCTest
@testable import LlmIdeMacLib

/// The adapter is deliberately thin — the server maps, dedups and chunks — so
/// these tests pin the three things it alone is responsible for: carrying the
/// item id across the fetch→markSeen boundary (the protocol has no id field),
/// not marking anything seen when nothing was fetched, and building a classify
/// payload the generic classifier can actually use.
@MainActor
final class McpConnectorAdapterTests: XCTestCase {

    final class FakeTransport: McpConnectorTransport {
        var result = LlmIdeAPIClient.McpFetchResult.stub()
        var fetchError: Error?
        private(set) var fetchCalls: [(path: String, id: String, limit: Int)] = []
        private(set) var seenCalls: [(path: String, id: String, itemIds: [String])] = []

        func fetch(path: String, id: String, limit: Int) async throws -> LlmIdeAPIClient.McpFetchResult {
            fetchCalls.append((path, id, limit))
            if let fetchError { throw fetchError }
            return result
        }
        func markSeen(path: String, id: String, itemIds: [String]) async throws {
            seenCalls.append((path, id, itemIds))
        }
    }

    private let endpoints = SourceConnectorManifest.Endpoints(
        test: "/kb/mcp-connector/test", fetch: "/kb/mcp-connector/fetch",
        seen: "/kb/mcp-connector/seen", classify: "/kb/mcp-connector/classify")

    private func makeAdapter(_ t: FakeTransport) -> McpConnectorAdapter {
        McpConnectorAdapter(connectorId: "miro", endpoints: endpoints, limit: 50, transport: { _ in t })
    }

    private func makeCtx() -> SourceContext {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("mcp-ad-\(UUID().uuidString)")
        return SourceContext(api: LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456"),
                             config: AppConfig(userDefaults: UserDefaults(suiteName: "mcp-ad-\(UUID().uuidString)")!),
                             root: tmp, notesOutputFolder: tmp.appendingPathComponent("llm-doc"),
                             sourceConnectorRoot: tmp)
    }

    func testFetchHitsTheManifestPathWithTheConnectorId() async throws {
        let t = FakeTransport()
        t.result = .stub(items: [(id: "miro:b1:i1", fields: ["Board": "Alpha"], body: "ship it")])
        let batch = try await makeAdapter(t).fetch(makeCtx())

        XCTAssertEqual(t.fetchCalls.count, 1)
        // The path is a manifest PARAMETER, not a constant baked into the
        // adapter — that is what makes one adapter serve every MCP connector.
        XCTAssertEqual(t.fetchCalls[0].path, "/kb/mcp-connector/fetch")
        XCTAssertEqual(t.fetchCalls[0].id, "miro")
        XCTAssertEqual(t.fetchCalls[0].limit, 50)
        XCTAssertEqual(batch.items.count, 1)
        XCTAssertEqual(batch.items[0].body, "ship it")
        XCTAssertEqual(batch.items[0].fields["Board"], "Alpha")
    }

    /// SourceConnectorFetchedItem has no id field, so the id has to survive
    /// inside `fields` or markSeen has nothing to send and every sweep
    /// re-imports the whole board.
    func testTheItemIdSurvivesIntoFieldsAndBackOutThroughMarkSeen() async throws {
        let t = FakeTransport()
        t.result = .stub(items: [
            (id: "miro:b1:i1", fields: ["Board": "Alpha"], body: "one"),
            (id: "miro:b1:i2", fields: ["Board": "Alpha"], body: "two"),
        ])
        let adapter = makeAdapter(t)
        let batch = try await adapter.fetch(makeCtx())
        XCTAssertEqual(batch.items[0].fields["ItemId"], "miro:b1:i1")
        XCTAssertEqual(batch.items[1].fields["ItemId"], "miro:b1:i2")

        try await adapter.markSeen(makeCtx(), batch: batch, drained: true)
        XCTAssertEqual(t.seenCalls.count, 1)
        XCTAssertEqual(t.seenCalls[0].path, "/kb/mcp-connector/seen")
        XCTAssertEqual(t.seenCalls[0].id, "miro")
        XCTAssertEqual(t.seenCalls[0].itemIds, ["miro:b1:i1", "miro:b1:i2"])
    }

    /// There is no high-water to advance here, so `drained` gates nothing.
    /// Marking only on `drained` would re-import every capped batch forever.
    func testMarkSeenStillFiresWhenTheSourceHasNotDrained() async throws {
        let t = FakeTransport()
        t.result = .stub(items: [(id: "miro:b1:i1", fields: [:], body: "one")],
                         drained: false, overCap: 7)
        let adapter = makeAdapter(t)
        let batch = try await adapter.fetch(makeCtx())
        try await adapter.markSeen(makeCtx(), batch: batch, drained: false)
        XCTAssertEqual(t.seenCalls.map(\.itemIds), [["miro:b1:i1"]],
                       "a capped batch was still imported — it must still be marked seen")
    }

    func testMarkSeenIsSkippedEntirelyWhenNothingWasFetched() async throws {
        let t = FakeTransport()
        let adapter = makeAdapter(t)
        let batch = try await adapter.fetch(makeCtx())
        try await adapter.markSeen(makeCtx(), batch: batch, drained: true)
        XCTAssertTrue(t.seenCalls.isEmpty, "an empty sweep must not cost a round trip every tick")
    }

    func testServerReportedFailuresAndOverCapArePassedThrough() async throws {
        let t = FakeTransport()
        t.result = .stub(items: [], drained: false, overCap: 4, failures: ["Locked: board is private"])
        let batch = try await makeAdapter(t).fetch(makeCtx())
        XCTAssertFalse(batch.drained)
        XCTAssertEqual(batch.overCap, 4)
        XCTAssertEqual(batch.failures, ["Locked: board is private"])
    }

    func testAFetchErrorPropagates() async {
        let t = FakeTransport()
        t.fetchError = APIError.http(status: 400, code: "MCP_UNAUTHORIZED",
                                     message: "Connect Miro first.", details: nil)
        do {
            _ = try await makeAdapter(t).fetch(makeCtx())
            XCTFail("expected a throw — SourceConnector turns it into .failure(...)")
        } catch { /* expected */ }
    }

    func testClassifyRequestCarriesTheConnectorIdTitleDateAndText() {
        let item = RawInboxItem(
            url: URL(fileURLWithPath: "/tmp/x.txt"),
            date: Date(timeIntervalSince1970: 0),
            body: "ship it",
            hash: "h",
            headers: ["Subject": "Alpha — sticky_note", "Date": "2026-08-01T00:00:00Z", "Board": "Alpha"])
        let req = makeAdapter(FakeTransport()).classifyRequest(from: item)
        // connectorId is how the generic classifier names the source in its
        // prompt — the classify route is shared by every MCP connector.
        XCTAssertEqual(req.body["connectorId"], "miro")
        XCTAssertEqual(req.body["title"], "Alpha — sticky_note")
        XCTAssertEqual(req.body["date"], "2026-08-01T00:00:00Z")
        XCTAssertEqual(req.body["text"], "ship it")
    }
}

private extension LlmIdeAPIClient.McpFetchResult {
    /// `McpFetchResult` declares its own `init(from:)`, which suppresses the
    /// synthesized memberwise init — and adding a production one only tests
    /// would use is worse than decoding a fixture. Items are passed as tuples
    /// rather than `McpFetchedItem` values so this file never has to shadow
    /// that type's synthesized memberwise init.
    static func stub(items: [(id: String, fields: [String: String], body: String)] = [],
                     drained: Bool = true, overCap: Int = 0,
                     failures: [String] = []) -> Self {
        let payload: [String: Any] = [
            "items": items.map { ["id": $0.id, "fields": $0.fields, "body": $0.body] as [String: Any] },
            "drained": drained,
            "skipped": ["overCap": overCap],
            "failures": failures,
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(Self.self, from: data)
    }
}

// mac/Tests/LlmIdeMacTests/SourceConnectorRawFilenameTests.swift
//
// Regression cover for the "inbox items silently overwrite each other" bug.
//
// The raw filename used to be `<yyyy-MM-dd-HHmmss>-<slugify(fields.values.first)>`.
// `Dictionary.values.first` is arbitrary-order, and the MCP item mapper gives
// every item on one board the same Title/Board/ItemType and stamps `now` for
// anything without a date — so a whole batch shared one filename, each item
// clobbered the previous one (`.atomic` = overwrite), and every item was then
// marked seen. Permanent data loss.
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceConnectorRawFilenameTests: XCTestCase {

    /// One board, N stickies: identical Title/Board/ItemType/Date, distinct
    /// `ItemId` (the adapter always injects it). Every item must survive as its
    /// own raw file.
    final class BoardAdapter: SourceConnectorAdapter {
        let count: Int
        init(count: Int) { self.count = count }
        func fetch(_ ctx: SourceContext) async throws -> SourceConnectorFetchBatch {
            let items = (0..<count).map { i in
                SourceConnectorFetchedItem(
                    fields: ["Title": "Sprint board",
                             "Board": "Sprint board",
                             "ItemType": "sticky_note",
                             "ItemId": "item-\(i)",
                             "Date": "2026-08-22T10:00:00Z",
                             "Link": "https://miro.example/board/1"],
                    body: "sticky body \(i)")
            }
            return SourceConnectorFetchBatch(items: items, drained: true, overCap: 0, failures: [])
        }
        func markSeen(_ ctx: SourceContext, batch: SourceConnectorFetchBatch, drained: Bool) async throws {}
        func classifyRequest(from item: RawInboxItem) -> ClassifyRequest {
            ClassifyRequest(body: ["text": item.body])
        }
    }

    private func miroLikeManifest() -> SourceConnectorManifest {
        try! JSONDecoder().decode(SourceConnectorManifest.self, from: Data(#"""
        { "id":"miro","displayName":"Miro","icon":"square","emptyText":"none",
          "platforms":["miro"],"mode":"fetch","inboxFolder":"MiroInbox","noteType":"miro",
          "endpoints":{"test":"/t","fetch":"/f","seen":"/s","classify":"/c"},
          "adapter":"McpConnectorAdapter","configFields":[],
          "rawHeaders":{"Subject":"$Title","Board":"$Board","ItemType":"$ItemType",
                        "ItemId":"$ItemId","Date":"$Date","Link":"$Link"},
          "noiseFilter":{"minLength":3} }
        """#.utf8))
    }

    private func rawFiles(under root: URL) -> [String] {
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
        return e.compactMap { $0 as? URL }
            .filter { $0.pathExtension == "txt" }
            .map { $0.lastPathComponent }
    }

    func testEveryItemInABatchGetsItsOwnRawFile() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sc-uniq-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        let n = 30
        let connector = SourceConnector(manifest: miroLikeManifest(),
                                        adapterFactory: { BoardAdapter(count: n) })
        try connector.ensureSetup(at: tmp)

        let config = AppConfig(userDefaults: UserDefaults(suiteName: "sc-uniq-\(UUID().uuidString)")!)
        let ctx = SourceContext(
            api: LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456"), config: config, root: tmp,
            notesOutputFolder: tmp.appendingPathComponent("llm-doc"),
            sourceConnectorRoot: tmp,
            classify: { _, _ in
                SourceConnectorClassification(category: "work", noteWorthy: false,
                                              summary: "s", todos: [])
            })

        _ = await connector.fetchAndIngest(ctx)

        let files = rawFiles(under: tmp.appendingPathComponent("miro", isDirectory: true))
        XCTAssertEqual(Set(files).count, n,
                       "each of \(n) items must land in its own raw file; got \(Set(files).count) distinct names")
        XCTAssertEqual(files.count, n)
    }

    /// Re-fetching the same items must be idempotent: same ItemIds → same
    /// filenames → no duplicate raw files piling up.
    func testRefetchOfTheSameBatchDoesNotDuplicateRawFiles() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sc-uniq2-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        let connector = SourceConnector(manifest: miroLikeManifest(),
                                        adapterFactory: { BoardAdapter(count: 5) })
        try connector.ensureSetup(at: tmp)
        let config = AppConfig(userDefaults: UserDefaults(suiteName: "sc-uniq2-\(UUID().uuidString)")!)
        let ctx = SourceContext(
            api: LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456"), config: config, root: tmp,
            notesOutputFolder: tmp.appendingPathComponent("llm-doc"),
            sourceConnectorRoot: tmp,
            classify: { _, _ in
                SourceConnectorClassification(category: "work", noteWorthy: false,
                                              summary: "s", todos: [])
            })

        _ = await connector.fetchAndIngest(ctx)
        _ = await connector.fetchAndIngest(ctx)

        let files = rawFiles(under: tmp.appendingPathComponent("miro", isDirectory: true))
        XCTAssertEqual(files.count, 5, "a re-fetch rewrites the same names, it does not fan out")
    }

    /// The `ItemId`-free path (Slack-shaped fields): the slug is still derived
    /// from a field value, but a same-second collision with *different* content
    /// must not clobber — `InboxStore` disambiguates instead.
    func testItemIdFreeItemsWithIdenticalSlugsDoNotClobber() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("inbox-clobber-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let store = InboxStore(root: tmp)
        let headers = ["Channel": "#team", "Date": "2026-08-22T10:00:00Z"]
        let a = try store.write(headers: headers, body: "first message", slug: "team")
        let b = try store.write(headers: headers, body: "second message", slug: "team")

        XCTAssertNotEqual(a, b, "different content must not reuse the same raw filename")
        XCTAssertEqual(try String(contentsOf: a, encoding: .utf8).hasSuffix("first message"), true)
        XCTAssertEqual(try String(contentsOf: b, encoding: .utf8).hasSuffix("second message"), true)
    }

    /// Writing byte-identical content twice is a no-op, not a fan-out.
    func testIdenticalRewriteReusesTheSameFile() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("inbox-idem-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let store = InboxStore(root: tmp)
        let headers = ["Channel": "#team", "Date": "2026-08-22T10:00:00Z"]
        let a = try store.write(headers: headers, body: "same", slug: "team")
        let b = try store.write(headers: headers, body: "same", slug: "team")
        XCTAssertEqual(a, b)
    }
}

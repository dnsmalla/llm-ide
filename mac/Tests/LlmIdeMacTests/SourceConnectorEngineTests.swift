import XCTest
@testable import LlmIdeMacLib

final class SourceConnectorEngineTests: XCTestCase {
    func testNoteWriterWritesAndReportsHashes() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sc-note-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let writer = SourceConnectorNoteWriter(repoRoot: tmp, noteType: NoteType("slack"))

        let classification = SourceConnectorClassification(
            category: "work", noteWorthy: true, summary: "ship it",
            todos: [SourceConnectorClassification.Todo(title: "t", detail: "d", due: nil, priority: "med")])
        _ = try await writer.writeNote(
            headers: ["Channel": "#team", "User": "alice", "Date": "2026-07-31T09:00:00Z"],
            title: "#team — alice", date: AppDateFormatter.parseISO("2026-07-31T09:00:00Z")!,
            classification: classification, originalBody: "ship it",
            sourceHash: "abc123", rawFile: "SlackInbox/2026/07/x.txt")

        let hashes = try await writer.existingSourceHashes()
        XCTAssertTrue(hashes.contains("abc123"))
    }
}

// MARK: - SourceConnector (ensureSetup + fetchAndIngest)

@MainActor
extension SourceConnectorEngineTests {
    final class FakeAdapter: SourceConnectorAdapter {
        func fetch(_ ctx: SourceContext) async throws -> SourceConnectorFetchBatch {
            return SourceConnectorFetchBatch(items: [
                .init(fields: ["Channel": "#team", "User": "alice", "Ts": "1", "Date": "2026-07-31T09:00:00Z"],
                      body: "ship it")
            ], drained: true, overCap: 0, failures: [])
        }
        func markSeen(_ ctx: SourceContext, batch: SourceConnectorFetchBatch, drained: Bool) async throws {}
        func classifyRequest(from item: RawInboxItem) -> ClassifyRequest {
            ClassifyRequest(body: ["text": item.body])
        }
    }

    private func makeManifest() -> SourceConnectorManifest {
        try! JSONDecoder().decode(SourceConnectorManifest.self, from: Data(#"""
        { "id":"slack","displayName":"Slack","icon":"number","emptyText":"none",
          "platforms":["slack"],"mode":"fetch","inboxFolder":"SlackInbox","noteType":"slack",
          "endpoints":{"test":"/t","fetch":"/f","seen":"/s","classify":"/c"},
          "adapter":"FakeAdapter","configFields":[],
          "rawHeaders":{"Channel":"$Channel","User":"$User","Ts":"$Ts","Date":"$Date"},
          "noiseFilter":{"minLength":2,"skipEmojiOnly":true} }
        """#.utf8))
    }

    func testEnsureSetupCreatesInboxAndLlmDocFolders() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("sc-setup-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let connector = SourceConnector(manifest: makeManifest(), adapterFactory: { FakeAdapter() })
        try connector.ensureSetup(at: tmp)
        // Raw inbox folder is now `<noteType>/` (slack), not the legacy `inboxFolder`.
        XCTAssertTrue(FileManager.default.fileExists(atPath: tmp.appendingPathComponent("slack").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: tmp.appendingPathComponent("llm-doc").appendingPathComponent("slack").path))
    }

    func testEnsureSetupIsIdempotent() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("sc-idem-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let connector = SourceConnector(manifest: makeManifest(), adapterFactory: { FakeAdapter() })
        try connector.ensureSetup(at: tmp)
        try connector.ensureSetup(at: tmp)
    }

    /// End-to-end `fetchAndIngest`: one fetch → one note written; a second
    /// fetch of the same item is deduped (raw content hash already has a
    /// note). The classify POST is stubbed via `SourceContext.classify` so the
    /// test never hits the network and never force-casts `LlmIdeAPIClient`.
    func testFetchAndIngestWritesNoteAndDedupsOnRerun() async throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("sc-e2e-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        let connector = SourceConnector(manifest: makeManifest(), adapterFactory: { FakeAdapter() })
        try connector.ensureSetup(at: tmp)

        let config = AppConfig(userDefaults: UserDefaults(suiteName: "sc-e2e-\(UUID().uuidString)")!)
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        let ctx = SourceContext(
            api: api, config: config, root: tmp,
            notesOutputFolder: tmp.appendingPathComponent("llm-doc"),
            sourceConnectorRoot: tmp,
            classify: { _, _ in
                SourceConnectorClassification(
                    category: "work", noteWorthy: true, summary: "s",
                    todos: [SourceConnectorClassification.Todo(title: "t", detail: "d", due: nil, priority: "med")])
            })

        let r1 = await connector.fetchAndIngest(ctx)
        if case .imported(let n, _, _) = r1 {
            XCTAssertEqual(n, 1)
        } else {
            XCTFail("expected .imported(1), got \(r1)")
        }

        // Second run: same item re-fetched and re-written to the inbox, but
        // its content hash already has a note → nothing new processed.
        let r2 = await connector.fetchAndIngest(ctx)
        if case .none = r2 { /* ok */ } else { XCTFail("expected .none on rerun, got \(r2)") }
    }
}

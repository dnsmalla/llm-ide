import XCTest
@testable import LlmIdeMacLib

final class SourceConnectorManifestTests: XCTestCase {
    private let slackJSON = #"""
    {
      "id": "slack", "displayName": "Slack", "icon": "number",
      "emptyText": "No Slack messages yet", "platforms": ["slack"], "mode": "fetch",
      "inboxFolder": "SlackInbox", "noteType": "slack",
      "endpoints": { "test":"/kb/slack/test", "fetch":"/kb/slack/fetch",
                     "seen":"/kb/slack/seen", "classify":"/kb/slack/classify" },
      "adapter": "SlackConnectorAdapter",
      "configFields": [
        { "key":"channels", "label":"Channels", "type":"stringList", "required":true },
        { "key":"lookbackDays", "label":"Lookback (days)", "type":"int", "default":7 }
      ],
      "rawHeaders": { "Channel":"$channelId", "User":"$user", "Ts":"$ts", "Date":"$date" },
      "noiseFilter": { "minLength":2, "skipEmojiOnly":true }
    }
    """#

    func testDecodesSlackManifest() throws {
        let manifest = try JSONDecoder().decode(SourceConnectorManifest.self, from: Data(slackJSON.utf8))
        XCTAssertEqual(manifest.id, "slack")
        XCTAssertEqual(manifest.noteType, "slack")
        XCTAssertEqual(manifest.inboxFolder, "SlackInbox")
        XCTAssertEqual(manifest.mode, .fetch)
        XCTAssertEqual(manifest.endpoints.classify, "/kb/slack/classify")
        XCTAssertEqual(manifest.adapter, "SlackConnectorAdapter")
        XCTAssertEqual(manifest.rawHeaders["Channel"], "$channelId")
        XCTAssertEqual(manifest.noiseFilter?.minLength, 2)
        XCTAssertEqual(manifest.configFields.first?.type, .stringList)
    }

    /// The bundled manifests are now real shipped artifacts, so this test
    /// parses the actual JSON rather than asserting the loader finds nothing.
    /// (It used to assert `[]` — which passed only because `Bundle.main` is
    /// the xctest runner under `swift test`, not because the loader worked.)
    func testLoadBundledParsesEveryShippedManifest() {
        let all = SourceConnectorManifest.loadBundled()
        XCTAssertEqual(all.map(\.id), ["gcal", "gdrive", "miro"],
                       "loadBundled sorts by id; a decode failure silently drops a manifest")
        for m in all {
            XCTAssertFalse(m.displayName.isEmpty)
            XCTAssertEqual(m.mode, .fetch)
            XCTAssertFalse(SourceConnectorManifest.reservedNoteTypes.contains(m.noteType),
                           "\(m.id) would shadow a legacy llm-doc directory")
            XCTAssertEqual(m.adapter, "McpConnectorAdapter",
                           "one generic adapter serves every MCP connector")
            // Every MCP connector shares one route family; the id is in the body.
            XCTAssertEqual(m.endpoints.test,     "/kb/mcp-connector/test")
            XCTAssertEqual(m.endpoints.fetch,    "/kb/mcp-connector/fetch")
            XCTAssertEqual(m.endpoints.seen,     "/kb/mcp-connector/seen")
            XCTAssertEqual(m.endpoints.classify, "/kb/mcp-connector/classify")
        }
    }

    /// The rawHeaders map is the contract with the server's mapItem field set
    /// (`connectors/mcp-connector-defs.mjs`). A drift here writes empty headers
    /// into every raw file, and the note title silently becomes the connector
    /// name — a failure that looks like "the LLM is bad at titles".
    func testMiroManifestMapsEveryFieldTheServerSends() throws {
        let miro = try XCTUnwrap(SourceConnectorManifest.loadBundled().first { $0.id == "miro" })
        XCTAssertEqual(miro.noteType, "miro", "notes must land in llm-doc/miro/")
        XCTAssertEqual(miro.platforms, ["miro"])
        for (header, token) in ["Subject": "$Title", "Board": "$Board",
                                "ItemType": "$ItemType", "ItemId": "$ItemId",
                                "Date": "$Date", "Link": "$Link", "Part": "$Part"] {
            XCTAssertEqual(miro.rawHeaders[header], token, "rawHeaders[\(header)]")
        }
        // `Subject` specifically: SourceConnector.generateNote reads it for the
        // note title before falling back to an arbitrary sorted header.
        XCTAssertEqual(miro.rawHeaders["Subject"], "$Title")
        XCTAssertEqual(miro.noiseFilter?.minLength, 3)
    }

    /// Reserved-noteType guard: a connector `noteType` that collides with a
    /// legacy plural note directory (`meetings/`, `emails/`, `documents/`)
    /// would shadow it, so `loadBundled` drops it via the same filter.
    func testDropsManifestsWithReservedLegacyNoteType() throws {
        let reservedJSON = slackJSON
            .replacingOccurrences(of: "\"id\": \"slack\",", with: "\"id\": \"slack-reserved\",")
            .replacingOccurrences(of: "\"noteType\": \"slack\",", with: "\"noteType\": \"meetings\",")
        let slack = try JSONDecoder().decode(SourceConnectorManifest.self, from: Data(slackJSON.utf8))
        let reserved = try JSONDecoder().decode(SourceConnectorManifest.self, from: Data(reservedJSON.utf8))

        let filtered = SourceConnectorManifest.droppingReservedNoteTypes([slack, reserved])
        XCTAssertEqual(filtered, [slack])
    }
}

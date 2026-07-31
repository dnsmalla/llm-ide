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

    func testLoadBundledReturnsEmptyWhenNoResources() {
        let all = SourceConnectorManifest.loadBundled()
        XCTAssertEqual(all, [])
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

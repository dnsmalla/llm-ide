import Foundation

typealias SlackMessage = LlmIdeAPIClient.SlackMessage
typealias SlackTestResult = LlmIdeAPIClient.SlackTestResult

// External Slack source endpoints. The bot token is written to the server
// vault via `setSecret` (key `slack.botToken`) — `/kb/slack/test` and
// `/kb/slack/fetch` read it back for the calling user. Mirrors +Email.
extension LlmIdeAPIClient {

    struct SlackTestResult: Decodable {
        let ok: Bool
        let team: String
        let user: String
    }

    struct SlackMessage: Decodable, Identifiable {
        let ts: String
        let channelId: String
        let user: String
        let text: String
        let threadTs: String?
        var id: String { "\(channelId):\(ts)" }
    }

    struct SlackSkipped: Decodable { let overCap: Int }

    struct SlackFetchResult: Decodable {
        let messages: [SlackMessage]
        let skipped: SlackSkipped
    }

    func testSlack() async throws -> SlackTestResult {
        struct Req: Encodable {}
        return try await post("/kb/slack/test", body: Req(), authenticated: true)
    }

    func fetchSlack(channelId: String) async throws -> SlackFetchResult {
        struct Req: Encodable { let channelId: String }
        return try await post("/kb/slack/fetch", body: Req(channelId: channelId), authenticated: true)
    }

    func markSlackSeen(channelId: String, messageTs: [String], lastTs: String?) async throws {
        struct Req: Encodable { let channelId: String; let messageTs: [String]; let lastTs: String? }
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await post("/kb/slack/seen",
                                    body: Req(channelId: channelId, messageTs: messageTs, lastTs: lastTs),
                                    authenticated: true)
    }
}

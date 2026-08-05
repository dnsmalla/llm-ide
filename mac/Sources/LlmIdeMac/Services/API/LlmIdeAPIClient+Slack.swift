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

    func fetchSlack(channelId: String, lookbackDays: Int) async throws -> SlackFetchResult {
        struct Req: Encodable { let channelId: String; let lookbackDays: Int }
        return try await post("/kb/slack/fetch", body: Req(channelId: channelId, lookbackDays: lookbackDays), authenticated: true)
    }

    func markSlackSeen(channelId: String, messageTs: [String], lastTs: String?) async throws {
        struct Req: Encodable { let channelId: String; let messageTs: [String]; let lastTs: String? }
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await post("/kb/slack/seen",
                                    body: Req(channelId: channelId, messageTs: messageTs, lastTs: lastTs),
                                    authenticated: true)
    }
}

extension LlmIdeAPIClient {
    /// Generic classify POST for any Source Connector: sends the adapter-built
    /// field map and decodes the shared classification shape.
    func postClassification(path: String, body: [String: String]) async throws -> SourceConnectorClassification {
        struct Req: Encodable { let body: [String: String] }
        return try await post(path, body: Req(body: body), authenticated: true)
    }
}

// MARK: - Hosted OAuth connect (one-click "Connect Slack")
extension LlmIdeAPIClient {

    /// One channel/group the connected Slack user already belongs to.
    struct SlackConversation: Decodable, Identifiable {
        let id: String
        let name: String
    }

    /// Result of `/auth/slack/start` — the browser URL to open plus the
    /// opaque state token used to poll for completion.
    struct SlackConnectStartResult: Decodable { let authUrl: String; let state: String }

    /// Result of `/auth/slack/status` — `status` is one of
    /// pending|complete|error|unknown (unknown = expired/never-existed state,
    /// OR a terminal status that was already read once — the server's state
    /// store is single-use); `teamName` populates once complete. No
    /// `channels` here — the server's OAuth callback deliberately doesn't
    /// prefetch channels (it would block the public redirect page for up
    /// to 90s under Slack rate-limiting); callers fetch the channel list
    /// separately via `fetchSlackConversations()` right after seeing
    /// `status == "complete"`.
    struct SlackConnectStatusResult: Decodable {
        let status: String
        let teamName: String?
        let message: String?
    }

    /// Kick off the hosted Slack OAuth flow (LLM-IDE's own Slack App — no
    /// client id/secret from the user). Returns a browser URL to open plus a
    /// state token to poll via `slackConnectStatus`.
    func slackConnectStart() async throws -> SlackConnectStartResult {
        struct Req: Encodable {}
        return try await post("/auth/slack/start", body: Req(), authenticated: true)
    }

    /// Poll the state of an in-flight Slack connect started via `slackConnectStart`.
    func slackConnectStatus(state: String) async throws -> SlackConnectStatusResult {
        let encoded = state.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? state
        return try await get("/auth/slack/status?state=\(encoded)", authenticated: true)
    }

    /// Result of `/kb/slack/conversations`. `complete == false` means the list
    /// was cut short (Slack rate-limited, hit the page cap, or the request
    /// timed out) — the UI should say so rather than presenting a truncated
    /// set as if it were the user's full channel list.
    struct SlackConversationsResult: Decodable {
        let channels: [SlackConversation]
        let complete: Bool
    }

    /// Channels/groups the connected Slack user belongs to, for the
    /// "Connect Slack" checklist. Requires slack.userToken or slack.botToken
    /// to already be saved.
    func fetchSlackConversations() async throws -> SlackConversationsResult {
        try await get("/kb/slack/conversations", authenticated: true)
    }
}

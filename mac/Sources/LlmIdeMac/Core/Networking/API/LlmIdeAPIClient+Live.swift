import Foundation

extension LlmIdeAPIClient {

    // --- Live session stream (cross-client) ---------------------------

    struct LiveSessionInfo: Codable, Identifiable {
        let sessionId: String
        let meetingTitle: String?
        let startedAt: Double
        let lastWrite: Double
        let captionCount: Int
        let sequence: Int
        var id: String { sessionId }
    }

    struct LiveCaption: Codable, Identifiable {
        let seq: Int
        let speaker: String
        let text: String
        let ts: Double
        let source: String
        let meta: LiveCaptionMeta?
        var id: Int { seq }
    }

    /// Optional grounding info attached to agent-question captions —
    /// see meeting-agent.mjs.  Drives the "Why did the agent ask
    /// this?" popover in TranscriptView.
    struct LiveCaptionMeta: Codable, Equatable {
        let planTaskId: String?
        let score: Double?
        let reason: String?
    }

    struct LiveCaptionsResponse: Codable {
        let captions: [LiveCaption]
        let sequence: Int
        let finalized: Bool
        let exists: Bool
        let meetingTitle: String?
        let startedAt: Double?
    }

    // --- Live methods ------------------------------------------------

    func listLiveSessions() async throws -> [LiveSessionInfo] {
        struct Wrap: Decodable { let sessions: [LiveSessionInfo] }
        let r: Wrap = try await get("/kb/live/sessions", authenticated: true)
        return r.sessions
    }

    func liveCaptions(sessionId: String, since: Int) async throws -> LiveCaptionsResponse {
        try await get("/kb/live/\(percentEncoded(sessionId))?since=\(since)", authenticated: true)
    }
}

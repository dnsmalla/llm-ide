import Foundation

// POST /kb/complete — one prompt in, one text answer out (server API v88).
// No tools, no history, no mode, no SSE. Wire contract:
// extension/routes/complete.mjs; schema/http/notes-generation.schema.json.

extension LlmIdeAPIClient {

    /// Field names are the server contract — `CompleteRouteTests`
    /// pins them. Optional fields are omitted when nil.
    struct CompleteRequest: Encodable, Equatable {
        let prompt: String
        let language: String?
        let model: String?
        /// Server wire provider id; a provider without a key answers 400
        /// `PROVIDER_UNAVAILABLE`, same envelope as `/code-assist`.
        let provider: String?
        /// `"subagent"` selects the deployment's sub-model tier when `model` is nil.
        let tier: String?
        /// `"code-assist"` sends the prompt inside `/code-assist`'s legacy
        /// wrapper (byte-identical model input for a caller migrating off it).
        let framing: String?
    }

    public struct CompleteResponse: Codable, Equatable {
        public let reply: String
        public let usage: Usage?

        public struct Usage: Codable, Equatable {
            public let inputTokens: Int
            public let outputTokens: Int
            public let cacheReadTokens: Int?
            public let cacheCreationTokens: Int?
            public let modelCalls: Int
        }
    }

    /// One plain completion. Throws `APIError.http(status: 404, …)` against a
    /// server older than API v88 (the caller decides whether to fall back).
    func complete(prompt: String, language: String? = nil, model: String? = nil,
                  provider: String? = nil, tier: String? = nil,
                  framing: String? = nil) async throws -> CompleteResponse {
        try await post(
            "/kb/complete",
            body: CompleteRequest(prompt: prompt, language: language, model: model,
                                  provider: provider, tier: tier, framing: framing),
            authenticated: true)
    }
}

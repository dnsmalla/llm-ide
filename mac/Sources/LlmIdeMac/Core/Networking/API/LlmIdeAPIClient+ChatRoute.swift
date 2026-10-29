import Foundation

// The session router's three routes (server API v91, docs/spec/session-router.md):
//   GET /agent/v2/session/route?chatSessionId=      the chat's route
//   PUT /agent/v2/session/route                     change the pin or the cap
//   GET /agent/v2/session/route/history?chatSessionId=
// Wire contract: schema/http/agent.schema.json.

extension LlmIdeAPIClient {

    public struct ChatRouteState: Codable, Equatable, Sendable {
        public struct Used: Codable, Equatable, Sendable {
            public let inTokens: Int
            public let outTokens: Int
            public let cacheWrite: Int
            public let cacheRead: Int
            public let billable: Int
            enum CodingKeys: String, CodingKey {
                case inTokens = "in", outTokens = "out", cacheWrite, cacheRead, billable
            }
        }
        public struct Pending: Codable, Equatable, Sendable {
            public let provider: String
            public let model: String
            public let pinnedBy: String
            public let requestedAt: String
        }
        /// False when the server runs without LLMIDE_ROUTER=on: the record is the empty default.
        public let enabled: Bool
        /// Whether the cap is enforced (LLMIDE_ROUTER_CAP=on) or only stored.
        public let capEnforced: Bool
        public let chatSessionId: String
        public let provider: String
        public let model: String
        public let pinned: Bool
        public let pinnedBy: String
        public let tokenLimit: Int?
        public let used: Used
        public let remaining: Int?
        public let stickyUntil: String?
        public let warm: [String: String]
        public let switchSeq: Int
        public let pending: Pending?
        public let updatedAt: String?
        // PUT only.
        public let appliesAt: String?
        public let changed: Bool?
        public let coldSwitch: Bool?
        public let estimatedPrefillTokens: Int?

        public var snapshot: ChatRouteSnapshot {
            ChatRouteSnapshot(provider: provider, model: model, tokenLimit: tokenLimit,
                              billableUsed: used.billable, cacheRead: used.cacheRead, switchSeq: switchSeq)
        }
    }

    public struct ChatRouteEvent: Codable, Equatable, Sendable, Identifiable {
        public let id: Int
        public let at: String
        public let kind: String
        public let fromProvider: String?
        public let fromModel: String?
        public let toProvider: String?
        public let toModel: String?
        public let reason: String?
        public let coldPrefillTokens: Int?
        public let handoffChars: Int?
    }

    public struct ChatRouteHistory: Codable, Equatable, Sendable {
        public let events: [ChatRouteEvent]
        /// True when the server's history store is down; routing is unaffected.
        public let degraded: Bool
    }

    /// The body of a PUT. `tokenLimit` is `Int??`: absent = leave it, `.some(nil)` = clear the cap
    /// (sent as JSON null), a number = set it. Provider and model travel together.
    public struct ChatRoutePatch: Encodable, Equatable, Sendable {
        public var chatSessionId: String
        public var provider: String?
        public var model: String?
        public var tokenLimit: Int??
        public var tokensUsed: Int?
        public var ifSeq: Int?

        public init(chatSessionId: String, provider: String? = nil, model: String? = nil,
                    tokenLimit: Int?? = nil, tokensUsed: Int? = nil, ifSeq: Int? = nil) {
            self.chatSessionId = chatSessionId
            self.provider = provider
            self.model = model
            self.tokenLimit = tokenLimit
            self.tokensUsed = tokensUsed
            self.ifSeq = ifSeq
        }

        enum CodingKeys: String, CodingKey { case chatSessionId, provider, model, tokenLimit, tokensUsed, ifSeq }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(chatSessionId, forKey: .chatSessionId)
            try c.encodeIfPresent(provider, forKey: .provider)
            try c.encodeIfPresent(model, forKey: .model)
            if let limit = tokenLimit {
                if let value = limit { try c.encode(value, forKey: .tokenLimit) } else { try c.encodeNil(forKey: .tokenLimit) }
            }
            try c.encodeIfPresent(tokensUsed, forKey: .tokensUsed)
            try c.encodeIfPresent(ifSeq, forKey: .ifSeq)
        }
    }

    private func routePath(_ base: String, chatSessionId: String) -> String {
        var c = URLComponents()
        c.path = base
        c.queryItems = [URLQueryItem(name: "chatSessionId", value: chatSessionId)]
        return (c.string ?? base)
    }

    /// The chat's route. Throws `APIError.http(status: 404, …)` against a server older than API v91.
    func chatRoute(chatSessionId: String) async throws -> ChatRouteState {
        try await get(routePath("/agent/v2/session/route", chatSessionId: chatSessionId), authenticated: true)
    }

    func putChatRoute(_ patch: ChatRoutePatch) async throws -> ChatRouteState {
        try await put("/agent/v2/session/route", body: patch, authenticated: true)
    }

    func chatRouteHistory(chatSessionId: String) async throws -> ChatRouteHistory {
        try await get(routePath("/agent/v2/session/route/history", chatSessionId: chatSessionId), authenticated: true)
    }
}

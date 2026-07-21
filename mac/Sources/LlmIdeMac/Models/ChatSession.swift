import Foundation

/// Which sidebar section a chat belongs to. A section can own many chats;
/// `ChatSessionStore.list(for:)` filters the UUID session files down to
/// this scope. Add a case when a new section gets chat.
enum ChatScope: String, Codable, CaseIterable {
    case explorer, conflicts, visual, docGen
}

/// One persisted Code Assistant chat. Stored as its own
/// `sessions/<uuid>.json` file under Application Support, tagged with the
/// sidebar section (`scope`) it belongs to, so a section can have multiple
/// chats and a turn only rewrites one small file.
struct ChatSession: Identifiable, Codable, Equatable {
    var storeVersion: Int = 1
    let id: UUID
    /// Section this chat belongs to. Nil only when decoding legacy UUID
    /// files written before scope existed — those are orphans and must not
    /// appear in `list(for:)`.
    var scope: ChatScope?
    var title: String
    let createdAt: Date
    var lastUsedAt: Date
    var history: [LlmIdeAPIClient.CodeAssistTurn]

    init(id: UUID = UUID(),
         scope: ChatScope,
         title: String = "New chat",
         createdAt: Date = Date(),
         lastUsedAt: Date = Date(),
         history: [LlmIdeAPIClient.CodeAssistTurn] = []) {
        self.id = id
        self.scope = scope
        self.title = title
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.history = history
    }

    enum CodingKeys: String, CodingKey {
        case storeVersion, id, scope, title, createdAt, lastUsedAt, history
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.storeVersion = (try? c.decode(Int.self, forKey: .storeVersion)) ?? 1
        self.id = try c.decode(UUID.self, forKey: .id)
        self.scope = try? c.decode(ChatScope.self, forKey: .scope)
        self.title = try c.decode(String.self, forKey: .title)
        self.createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.lastUsedAt = try c.decode(Date.self, forKey: .lastUsedAt)
        self.history = try c.decode([LlmIdeAPIClient.CodeAssistTurn].self, forKey: .history)
    }
}

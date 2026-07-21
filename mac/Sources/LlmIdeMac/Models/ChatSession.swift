import Foundation

/// Which sidebar section a chat belongs to. The section IS the chat
/// identity: each scope maps to exactly one persisted chat file
/// (`sessions/<scope>.json`). Add a case when a new section gets chat.
enum ChatScope: String, Codable, CaseIterable {
    case explorer, conflicts, visual, docGen
}

/// One persisted Code Assistant chat for a single sidebar section. Each
/// section owns exactly one session, stored as `sessions/<scope>.json`; the
/// section (not this struct) is the identity, so there is no `scope` field
/// here. Lives as a standalone JSON file under Application Support so a turn
/// only rewrites one small file.
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

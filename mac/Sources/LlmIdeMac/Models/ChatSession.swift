import Foundation

/// Which sidebar section a chat belongs to. The section IS the chat
/// identity: each scope maps to exactly one persisted chat file
/// (`sessions/<scope>.json`). Add a case when a new section gets chat.
enum ChatScope: String, Codable, CaseIterable {
    case explorer, conflicts, visual, docGen
}

/// One persisted Code Assistant chat session — Cursor-style, where the
/// user can have many parallel conversations and switch between them
/// from a dropdown in the panel header. Each session lives as a
/// standalone JSON file under Application Support so we don't have to
/// rewrite a giant index every time one turn lands.
struct ChatSession: Identifiable, Codable, Equatable {
    /// Persistence schema version. Bump whenever the on-disk layout
    /// breaks. Absent on legacy files written before this field
    /// existed — `init(from:)` defaults to `1` in that case so old
    /// sessions keep decoding. See `docs/reference/persistence.md`.
    var storeVersion: Int = 1
    let id: UUID
    /// Auto-derived from the first user turn the first time the user
    /// sends a message in this session. Can be renamed later (UI not
    /// shipped in this commit but the field is editable).
    var title: String
    let createdAt: Date
    var lastUsedAt: Date
    var history: [LlmIdeAPIClient.CodeAssistTurn]

    init(id: UUID = UUID(),
         title: String = "New chat",
         createdAt: Date = Date(),
         lastUsedAt: Date = Date(),
         history: [LlmIdeAPIClient.CodeAssistTurn] = []) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.history = history
    }

    // Custom decode so files written before `storeVersion` existed
    // continue to load. New writes always include the field.
    enum CodingKeys: String, CodingKey {
        case storeVersion, id, title, createdAt, lastUsedAt, history
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.storeVersion = (try? c.decode(Int.self, forKey: .storeVersion)) ?? 1
        self.id = try c.decode(UUID.self, forKey: .id)
        self.title = try c.decode(String.self, forKey: .title)
        self.createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.lastUsedAt = try c.decode(Date.self, forKey: .lastUsedAt)
        self.history = try c.decode([LlmIdeAPIClient.CodeAssistTurn].self, forKey: .history)
    }
}

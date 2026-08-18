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
///
/// v2 envelope (`storeVersion == 2`): `messages: [ChatMessage]` replaces the
/// flat v1 `history: [LlmIdeAPIClient.CodeAssistTurn]`. `init(from:)`
/// transparently migrates any v1 file it reads (decodes the legacy `history`
/// key, runs each turn through `ChatMessage.migrate`, and bumps
/// `storeVersion` to 2 in memory) so a v1 file rewrites itself as v2 the
/// next time it's saved — `encode(to:)` always writes the v2 shape.
struct ChatSession: Identifiable, Codable, Equatable {
    var storeVersion: Int = 2
    let id: UUID
    /// Section this chat belongs to. Nil only when decoding legacy UUID
    /// files written before scope existed — those are orphans and must not
    /// appear in `list(for:)`.
    var scope: ChatScope?
    var title: String
    let createdAt: Date
    var lastUsedAt: Date
    var messages: [ChatMessage]
    /// Engine this chat runs on, stamped once at creation (the D3 clean cut):
    /// nil — or the field absent in an older file — = the legacy engine
    /// forever; `"agentV2"` (`AgentV2Selection.sessionEngineV2`) = the Agent
    /// v2 engine. Never rewritten after creation: flipping the beta toggle
    /// does not migrate an existing chat (a mid-chat swap would hand a
    /// context-blind fresh SDK session the next turn); the toggle only
    /// governs NEW chats, plus acts as a global kill switch when off.
    var engine: String?

    init(id: UUID = UUID(),
         scope: ChatScope,
         title: String = "New chat",
         createdAt: Date = Date(),
         lastUsedAt: Date = Date(),
         messages: [ChatMessage] = [],
         engine: String? = nil) {
        self.id = id
        self.scope = scope
        self.title = title
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.messages = messages
        self.engine = engine
    }

    enum CodingKeys: String, CodingKey {
        case storeVersion, id, scope, title, createdAt, lastUsedAt, messages, history, engine
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(UUID.self, forKey: .id)
        self.scope = try? c.decode(ChatScope.self, forKey: .scope)
        self.title = try c.decode(String.self, forKey: .title)
        self.createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.lastUsedAt = try c.decode(Date.self, forKey: .lastUsedAt)
        // Optional decode so files persisted before the engine marker
        // existed (every chat today) decode as legacy — nil, never a throw.
        self.engine = try? c.decode(String.self, forKey: .engine)
        if let v2Messages = try? c.decode([ChatMessage].self, forKey: .messages) {
            // Already v2 — decode directly, no migration.
            self.storeVersion = (try? c.decode(Int.self, forKey: .storeVersion)) ?? 2
            self.messages = v2Messages
        } else {
            // v1 file: legacy `history` key of `{role, content}` turns. Run
            // each through the shared migration transform, stamping every
            // migrated message with the SESSION's `lastUsedAt` as its
            // `createdAt` — v1 turns carried no per-turn timestamp.
            let legacyTurns = try c.decode([LlmIdeAPIClient.CodeAssistTurn].self, forKey: .history)
            let migratedCreatedAt = self.lastUsedAt
            self.messages = legacyTurns.map { ChatMessage.migrate(role: $0.role, content: $0.content, sessionDate: migratedCreatedAt) }
            // In-memory, this file is now v2 shaped — the next save() writes
            // it back out as v2, so storeVersion reflects that immediately
            // rather than only after a round trip through disk.
            self.storeVersion = 2
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(storeVersion, forKey: .storeVersion)
        try c.encode(id, forKey: .id)
        try c.encode(scope, forKey: .scope)
        try c.encode(title, forKey: .title)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(lastUsedAt, forKey: .lastUsedAt)
        try c.encode(messages, forKey: .messages)
        try c.encodeIfPresent(engine, forKey: .engine)
    }
}

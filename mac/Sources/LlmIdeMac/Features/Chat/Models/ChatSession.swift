import Foundation
import os

// `ChatScope` lives in Core/Contracts/ChatScope.swift (a cross-feature value).

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
    /// Project this chat belongs to, or nil for a chat written before project
    /// identity existed. Optional so every existing session file still decodes
    /// unchanged — there is no migration step, and a nil id simply means
    /// "unknown project", which `list(for:projectId:)` treats as belonging to
    /// none rather than to all.
    ///
    /// Without this, a chat that follows the ACTIVE project (the quick chat)
    /// silently continues against a different repo when the user switches, its
    /// earlier turns discussing files that no longer exist.
    var projectId: String?

    // --- Live-then-archive tags (plan 3.10, Phase 4). All OPTIONAL: a file
    // without them decodes unchanged, and `storeVersion` stays 2. An OLD build
    // decodes a tagged file but DROPS these keys when it re-saves it (F14); the
    // tags are therefore also mirrored in the `chat-tags.json` sidecar that
    // `ChatSessionStore` keeps outside `sessions/`, and re-applied on load.

    /// The meeting this chat is attached to (deleted when that meeting's file is
    /// verified, plan Q3). Nil for every chat today.
    var meetingId: String?
    /// The signed-in user the chat belongs to (plan Q5/C16): another user never
    /// sees it. Nil on a file written before this existed = not yet claimed.
    var ownerUserId: String?
    /// Where the chat came from: `"extension"` for a chat archived from the
    /// server's live rows. Nil for a chat the Mac created.
    var origin: String?
    /// For an archived extension chat: the digest and count the Mac verified.
    var archive: ArchiveInfo?
    /// Session router (K1 P6b): the chat's pinned provider/model, its token limit and the billable
    /// tokens used. The server's route row is purged at quit, so this is what re-creates it on the next
    /// open. Optional with no storeVersion bump; also mirrored in `chat-tags.json` for an N-1 build.
    var route: ChatRouteSettings?

    struct ArchiveInfo: Codable, Equatable {
        let hash: String
        let count: Int
    }

    init(id: UUID = UUID(),
         scope: ChatScope,
         title: String = "New chat",
         createdAt: Date = Date(),
         lastUsedAt: Date = Date(),
         messages: [ChatMessage] = [],
         engine: String? = nil,
         projectId: String? = nil,
         meetingId: String? = nil,
         ownerUserId: String? = nil,
         origin: String? = nil,
         archive: ArchiveInfo? = nil,
         route: ChatRouteSettings? = nil) {
        self.route = route
        self.meetingId = meetingId
        self.ownerUserId = ownerUserId
        self.origin = origin
        self.archive = archive
        self.id = id
        self.scope = scope
        self.title = title
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.messages = messages
        self.engine = engine
        self.projectId = projectId
    }

    enum CodingKeys: String, CodingKey {
        case storeVersion, id, scope, title, createdAt, lastUsedAt, messages, history, engine, projectId
        case meetingId, ownerUserId, origin, archive, route
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
        // Optional decode so files persisted before project identity existed
        // (every chat today) decode as "unknown project" — nil, never a throw.
        self.projectId = try? c.decode(String.self, forKey: .projectId)
        // Live-then-archive tags: optional, never a throw (an old file has none).
        self.meetingId = try? c.decode(String.self, forKey: .meetingId)
        self.ownerUserId = try? c.decode(String.self, forKey: .ownerUserId)
        self.origin = try? c.decode(String.self, forKey: .origin)
        self.archive = try? c.decode(ArchiveInfo.self, forKey: .archive)
        self.route = try? c.decode(ChatRouteSettings.self, forKey: .route)
        // Decided by which key is PRESENT, never by whether the v2 decode
        // happened to throw: one message this build couldn't read used to
        // fail the `[ChatMessage]` decode, fall through to the v1 branch —
        // which requires a `history` key a v2 file doesn't have — and the
        // store then quarantined the whole session, logging a misleading
        // "keyNotFound history". Messages decode one by one now; an
        // unreadable one is dropped (and logged), the chat survives.
        if c.contains(.messages) {
            let lossy = try c.decode([LossyChatMessage].self, forKey: .messages)
            let v2Messages = lossy.compactMap(\.message)
            if v2Messages.count < lossy.count {
                chatSessionLog.warning("chat_session_messages_dropped count=\(lossy.count - v2Messages.count, privacy: .public)")
            }
            // Already v2 — decode directly, no migration.
            self.storeVersion = (try? c.decode(Int.self, forKey: .storeVersion)) ?? 2
            // Repair interrupted turns: a message can only reach disk as
            // `.streaming` if the app died mid-turn (streaming persists are
            // debounced, and a quit mid-turn flushes the partial as-is via
            // `ChatEngineRegistry.flushAll`). By load time no stream is
            // live for it, so leaving the status would render a truncated
            // partial as a FINISHED reply — and `wireTurn()` would replay it
            // to the model as complete. `.stopped` is the honest state: the
            // transcript styles it as interrupted, and the wire re-attaches
            // the "(stopped)" marker (ChatMessage.legacyTurn).
            self.messages = v2Messages.map { message in
                guard message.status == .streaming else { return message }
                var repaired = message
                repaired.status = .stopped
                return repaired
            }
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
        try c.encodeIfPresent(projectId, forKey: .projectId)
        try c.encodeIfPresent(meetingId, forKey: .meetingId)
        try c.encodeIfPresent(ownerUserId, forKey: .ownerUserId)
        try c.encodeIfPresent(origin, forKey: .origin)
        try c.encodeIfPresent(archive, forKey: .archive)
        try c.encodeIfPresent(route, forKey: .route)
    }
}

/// One persisted message that may not decode on this build.
private struct LossyChatMessage: Decodable {
    let message: ChatMessage?
    init(from decoder: Decoder) throws { message = try? ChatMessage(from: decoder) }
}

private let chatSessionLog = Logger(subsystem: "com.llmide.macapp", category: "chat-session")

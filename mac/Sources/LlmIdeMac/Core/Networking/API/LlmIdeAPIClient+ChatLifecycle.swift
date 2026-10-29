import Foundation

// Chat lifecycle routes (live-then-archive Phase 4, plan 3.2-3.5). Wire shapes:
// schema/http/lifecycle.schema.json. Every call is stateless; the decisions about
// WHEN to call (verify before purge, archive before commit) live in Chat's
// ChatArchiveService, never here.

extension LlmIdeAPIClient {

    struct WorkingChat: Codable, Equatable {
        let chatSessionId: String
        let sdkSession: String?
        let factCount: Int
        /// SQLite `datetime('now')` text ("YYYY-MM-DD HH:MM:SS", UTC), or nil when only facts remain.
        let updatedAt: String?
    }

    struct FailedPurge: Codable, Equatable {
        let chatSessionId: String
        let attempts: Int
    }

    struct PurgeStatus: Codable, Equatable {
        let pending: Int
        let failed: [FailedPurge]
    }

    struct WorkingStateResult: Codable, Equatable {
        let sessions: [WorkingChat]
        let purges: PurgeStatus
    }

    struct ArchiveReceiptRequest: Encodable {
        let chatSessionId: String
        let hash: String
        let count: Int
    }

    struct ArchiveReceiptResult: Codable, Equatable { let recorded: Bool }

    struct WorkingStatePurgeRequest: Encodable {
        let chatSessionIds: [String]
        let verified: Bool
    }

    struct WorkingStatePurgeResult: Codable, Equatable { let purged: Int }

    struct SessionPurgeRequest: Encodable {
        let chatSessionId: String
        let reason: String
    }

    struct SessionPurgeResult: Codable, Equatable {
        let queued: Bool
        /// done | pending | failed
        let purged: String
    }

    /// A live server chat row (the extension's rolling session), listing shape.
    struct ServerChatSummary: Codable, Equatable {
        let id: String
        let title: String
        let surface: String
        let mode: String
        let projectId: String?
        let createdAt: Double
        let updatedAt: Double
    }

    private struct ServerChatList: Decodable { let sessions: [ServerChatSummary] }

    struct ArchiveMessage: Codable, Equatable {
        let seq: Int
        let role: String
        let content: String
        let createdAt: Double
    }

    struct ArchiveIncomplete: Codable, Equatable {
        let incomplete: Bool
        let prunedMessages: Int
        let truncatedMessages: Int
    }

    struct ArchiveSnapshot: Codable, Equatable {
        let fence: Int
        let count: Int
        let hash: String
        let incomplete: ArchiveIncomplete
        let session: ServerChatSummary
        let messages: [ArchiveMessage]
        let nextAfter: Int?
    }

    struct ArchiveCommitRequest: Encodable {
        let fence: Int
        let hash: String
        let acceptIncomplete: Bool
    }

    struct ArchiveCommitResult: Codable, Equatable {
        let deleted: Bool
        /// deleted | already_archived
        let status: String
    }

    /// `GET /kb/agent/working-state`: the chats the server still holds working state for.
    func chatWorkingState() async throws -> WorkingStateResult {
        try await get("/kb/agent/working-state", authenticated: true)
    }

    /// `POST /kb/archive-receipts`: the Mac's own verification of the file it holds.
    func recordArchiveReceipt(chatSessionId: String, hash: String, count: Int) async throws {
        let _: ArchiveReceiptResult = try await post(
            "/kb/archive-receipts",
            body: ArchiveReceiptRequest(chatSessionId: chatSessionId, hash: hash, count: count),
            authenticated: true)
    }

    /// `POST /agent/v2/sessions/purge`: working state only (mapping, SDK transcript, facts).
    /// 409 NO_RECEIPT when any chat has no receipt; nothing is purged then.
    func purgeChatWorkingState(chatSessionIds: [String]) async throws -> Int {
        let r: WorkingStatePurgeResult = try await post(
            "/agent/v2/sessions/purge",
            body: WorkingStatePurgeRequest(chatSessionIds: chatSessionIds, verified: true),
            authenticated: true)
        return r.purged
    }

    /// `POST /kb/session-purges`: the delete-everywhere tombstone (durable before it purges).
    func queueSessionPurge(chatSessionId: String, reason: String = "user_delete") async throws -> SessionPurgeResult {
        try await post("/kb/session-purges",
                       body: SessionPurgeRequest(chatSessionId: chatSessionId, reason: reason),
                       authenticated: true)
    }

    /// `GET /kb/chat/sessions?surface=extension`: live extension chats on the server.
    func listExtensionChats() async throws -> [ServerChatSummary] {
        let r: ServerChatList = try await get("/kb/chat/sessions?surface=extension&limit=200", authenticated: true)
        return r.sessions
    }

    /// `POST /kb/chat/sessions/:id/archive/begin`. First page without `after`; a continuation
    /// passes the previous page's `nextAfter` and the fence of the first page.
    func archiveBegin(chatSessionId: String, after: Int? = nil, fence: Int? = nil) async throws -> ArchiveSnapshot {
        var path = "/kb/chat/sessions/\(chatSessionId)/archive/begin"
        if let after, let fence { path += "?after=\(after)&fence=\(fence)" }
        return try await post(path, body: EmptyBody(), authenticated: true)
    }

    /// `POST /kb/chat/sessions/:id/archive/commit`.
    func archiveCommit(chatSessionId: String, fence: Int, hash: String,
                       acceptIncomplete: Bool) async throws -> ArchiveCommitResult {
        try await post("/kb/chat/sessions/\(chatSessionId)/archive/commit",
                       body: ArchiveCommitRequest(fence: fence, hash: hash, acceptIncomplete: acceptIncomplete),
                       authenticated: true)
    }
}

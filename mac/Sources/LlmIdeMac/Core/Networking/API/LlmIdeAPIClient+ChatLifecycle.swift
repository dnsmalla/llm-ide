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
        /// The Mac file is gone: working state only, a chat with server rows is refused.
        let orphan: Bool?
    }

    struct WorkingStatePurgeResult: Codable, Equatable {
        let purged: Int
        /// A turn is running on these: not purged, retry later.
        let busy: [String]?
        /// Used after their receipt was written: not purged, verify the file again.
        let staleReceipt: [String]?
        /// orphan only: chats that still have server rows.
        let refused: [String]?
    }

    struct SessionPurgeRequest: Encodable {
        let chatSessionId: String
        let reason: String
        /// ISO time of the user's delete, kept across retries.
        let requestedAt: String?
    }

    struct SessionPurgeResult: Codable, Equatable {
        let queued: Bool
        /// done | pending | failed
        let purged: String
        let busy: Bool?
        let skippedReused: Bool?
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
    func purgeChatWorkingState(chatSessionIds: [String], orphan: Bool = false) async throws -> WorkingStatePurgeResult {
        try await post(
            "/agent/v2/sessions/purge",
            body: WorkingStatePurgeRequest(chatSessionIds: chatSessionIds, verified: true, orphan: orphan ? true : nil),
            authenticated: true)
    }

    /// `POST /kb/session-purges`: the delete-everywhere tombstone (durable before it purges).
    func queueSessionPurge(chatSessionId: String, reason: String = "user_delete",
                           requestedAt: Date? = nil) async throws -> SessionPurgeResult {
        try await post("/kb/session-purges",
                       body: SessionPurgeRequest(chatSessionId: chatSessionId, reason: reason,
                                                 requestedAt: requestedAt.map { ISO8601DateFormatter().string(from: $0) }),
                       authenticated: true)
    }

    /// `GET /kb/chat/sessions`: EVERY server chat row of the user, any surface, paged by offset until a short
    /// page. A caller that decides "this chat is not on the server" from the result needs the whole list.
    func listServerChats() async throws -> [ServerChatSummary] {
        try await Self.readAllPages(pageSize: 200, id: \.id) { offset in
            let r: ServerChatList = try await self.get("/kb/chat/sessions?limit=200&offset=\(offset)", authenticated: true)
            return r.sessions
        }
    }

    /// Read a list to its end through `fetch(offset)`. A server that ignores `offset` would repeat page one forever:
    /// that is an unreadable list (an error), never a complete one. Bounded by `maxPages`.
    static func readAllPages<T>(pageSize: Int, maxPages: Int = 500, id: (T) -> String,
                                fetch: (Int) async throws -> [T]) async throws -> [T] {
        var all: [T] = []
        var seen = Set<String>()
        for _ in 0..<maxPages {
            let page = try await fetch(all.count)
            if !page.isEmpty, page.allSatisfy({ seen.contains(id($0)) }) { throw URLError(.cannotParseResponse) }
            for item in page { seen.insert(id(item)) }
            all += page
            if page.count < pageSize { return all }
        }
        throw URLError(.dataLengthExceedsMaximum)
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

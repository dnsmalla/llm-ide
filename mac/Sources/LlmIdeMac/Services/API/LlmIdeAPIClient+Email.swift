import Foundation

// Top-level typealiases so call sites can reference these without the
// LlmIdeAPIClient prefix (mirrors LlmIdeAPIClient+KB.swift).
typealias EmailMessage = LlmIdeAPIClient.EmailMessage
typealias EmailTestResult = LlmIdeAPIClient.EmailTestResult

// External Email source endpoints. The IMAP password is written to the
// server-side secrets vault via `setSecret` (key `email.imapPassword`)
// rather than sent on every request — `/kb/email/test` and
// `/kb/email/fetch` read it back from the vault for the calling user.
extension LlmIdeAPIClient {

    /// Result of `/kb/email/test` — a quick connectivity + mailbox probe.
    struct EmailTestResult: Decodable {
        let ok: Bool
        let mailbox: String
        let total: Int
        let recent: Int
    }

    /// One fetched email. `messageId` is the stable dedup key (RFC 822
    /// Message-ID); `id` aliases it so SwiftUI lists can use `Identifiable`.
    struct EmailMessage: Decodable, Identifiable {
        let uid: Int
        let messageId: String
        let subject: String
        let from: String
        let date: String        // ISO-8601 string from the server
        let text: String
        var id: String { messageId }
    }

    /// Store a per-user secret in the server vault. Used for the IMAP app
    /// password (`email.imapPassword`) so it never has to be persisted in
    /// AppConfig/UserDefaults on the client.
    func setSecret(key: String, value: String) async throws {
        struct Req: Encodable { let key: String; let value: String }
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await post("/auth/me/secrets",
                                    body: Req(key: key, value: value),
                                    authenticated: true)
    }

    /// Probe an IMAP source without importing anything — confirms the
    /// vault password + connection settings work and reports counts.
    func testEmail(_ s: SavedEmailSource) async throws -> EmailTestResult {
        struct Req: Encodable {
            let host: String
            let port: Int
            let secure: Bool
            let user: String
            let mailbox: String
        }
        return try await post("/kb/email/test",
                              body: Req(host: s.host, port: s.port, secure: s.secure,
                                        user: s.user, mailbox: s.mailbox),
                              authenticated: true)
    }

    /// Counts of messages the server fetched but did NOT return: `oversize`
    /// (over the body-size cap) + `overCap` (beyond the per-fetch message cap).
    struct EmailSkipped: Decodable {
        let oversize: Int
        let overCap: Int
    }

    /// `/kb/email/fetch` result: the new (server-deduped) messages plus the
    /// skip counts to surface.
    struct EmailFetchResult: Decodable {
        let messages: [EmailMessage]
        let skipped: EmailSkipped
    }

    /// Fetch NEW messages from the configured mailbox. The server owns the
    /// forward-only high-water mark and the seen-ledger now, so it computes
    /// the `since` window itself and returns only messages not yet imported
    /// (no client-side dedup, device-independent). Optionally filtered to
    /// unread / a sender.
    func fetchEmails(_ s: SavedEmailSource) async throws -> EmailFetchResult {
        struct Req: Encodable {
            let host: String
            let port: Int
            let secure: Bool
            let user: String
            let mailbox: String
            let lookbackDays: Int
            let unreadOnly: Bool
            let fromFilter: String
        }
        return try await post("/kb/email/fetch",
                              body: Req(host: s.host, port: s.port, secure: s.secure,
                                        user: s.user, mailbox: s.mailbox,
                                        lookbackDays: s.lookbackDays,
                                        unreadOnly: s.unreadOnly,
                                        fromFilter: s.fromFilter),
                              authenticated: true)
    }

    /// Mark message-ids as imported (server-side dedup ledger) and, when
    /// `lastFetchedAt` is non-nil, advance the forward-only high-water mark.
    /// Called after a successful import; also used with empty ids +
    /// `lastFetchedAt = now` to initialize forward-only capture on connect.
    func markEmailSeen(messageIds: [String], lastFetchedAt: Date?) async throws {
        struct Req: Encodable { let messageIds: [String]; let lastFetchedAt: String? }
        struct Ack: Decodable { let ok: Bool }
        let iso = lastFetchedAt.map { AppDateFormatter.isoString($0) }
        let _: Ack = try await post("/kb/email/seen",
                                    body: Req(messageIds: messageIds, lastFetchedAt: iso),
                                    authenticated: true)
    }
}

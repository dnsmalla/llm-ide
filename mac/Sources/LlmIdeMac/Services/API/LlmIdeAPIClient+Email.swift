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
            // Tells the server which credential path to use: "google" reads the
            // stored OAuth refresh token (XOAUTH2), otherwise the vault password.
            let authMethod: String
        }
        return try await post("/kb/email/test",
                              body: Req(host: s.host, port: s.port, secure: s.secure,
                                        user: s.user, mailbox: s.mailbox,
                                        authMethod: s.authMethod),
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
            // "google" → server uses the stored OAuth token (XOAUTH2);
            // otherwise the vault app password.
            let authMethod: String
            // Mark fetched messages read (\Seen) in the mailbox.
            let markRead: Bool
        }
        return try await post("/kb/email/fetch",
                              body: Req(host: s.host, port: s.port, secure: s.secure,
                                        user: s.user, mailbox: s.mailbox,
                                        lookbackDays: s.lookbackDays,
                                        unreadOnly: s.unreadOnly,
                                        fromFilter: s.fromFilter,
                                        authMethod: s.authMethod,
                                        markRead: s.markRead),
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

    /// Result of `/auth/google/start` — the browser URL to open plus the
    /// opaque state token used to poll for completion.
    struct GoogleStartResult: Decodable { let authUrl: String; let state: String }

    /// Result of `/auth/google/status` — `status` is one of
    /// pending|complete|error; `email` is populated once complete.
    struct GoogleStatusResult: Decodable { let status: String; let email: String?; let message: String? }

    /// Kick off the Google OAuth loopback flow: the server stashes the
    /// bring-your-own client id/secret in the vault and returns a browser
    /// URL to open plus a state token to poll via `googleSignInStatus`.
    func googleSignInStart(clientId: String, clientSecret: String) async throws -> GoogleStartResult {
        struct Req: Encodable { let clientId: String; let clientSecret: String }
        return try await post("/auth/google/start",
                              body: Req(clientId: clientId, clientSecret: clientSecret),
                              authenticated: true)
    }

    /// Poll the state of an in-flight Google sign-in started via
    /// `googleSignInStart`.
    func googleSignInStatus(state: String) async throws -> GoogleStatusResult {
        let encoded = state.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? state
        return try await get("/auth/google/status?state=\(encoded)", authenticated: true)
    }

    /// One extracted to-do from an email (Phase 2 turns these into issues).
    struct EmailTodo: Decodable, Equatable {
        let title: String
        let detail: String
        let due: String?      // "YYYY-MM-DD" or nil
        let priority: String  // "low" | "med" | "high"
    }

    /// Result of `/kb/email/classify`.
    struct EmailClassification: Decodable, Equatable {
        let category: String
        let noteWorthy: Bool
        let summary: String
        let todos: [EmailTodo]
    }

    /// Classify a fetched email + extract to-dos. `noteWorthy == false` for
    /// automated/bulk mail (caller writes a raw stub instead of a note).
    func classifyEmail(subject: String, from: String, date: String, body: String) async throws -> EmailClassification {
        struct Req: Encodable { let subject: String; let from: String; let date: String; let body: String }
        return try await post("/kb/email/classify",
                              body: Req(subject: subject, from: from, date: date, body: body),
                              authenticated: true)
    }
}

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

    /// Fetch recent messages (within `lookbackDays`) from the configured
    /// mailbox. Dedup against already-imported message-ids happens
    /// client-side in the Sources ingest flow.
    func fetchEmails(_ s: SavedEmailSource) async throws -> [EmailMessage] {
        struct Req: Encodable {
            let host: String
            let port: Int
            let secure: Bool
            let user: String
            let mailbox: String
            let lookbackDays: Int
        }
        struct Resp: Decodable { let messages: [EmailMessage] }
        let resp: Resp = try await post("/kb/email/fetch",
                                        body: Req(host: s.host, port: s.port, secure: s.secure,
                                                  user: s.user, mailbox: s.mailbox,
                                                  lookbackDays: s.lookbackDays),
                                        authenticated: true)
        return resp.messages
    }
}

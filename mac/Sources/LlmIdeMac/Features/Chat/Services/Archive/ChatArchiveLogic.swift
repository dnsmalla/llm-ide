import CryptoKit
import Foundation

/// The pure decisions of the live-then-archive chat lifecycle (plan 3.2-3.5, T4.2).
/// Public so `chat-contract-lab` can assert them (a separate target sees only public
/// symbols): the hash a server commit is checked against, the verify-before-purge rule,
/// the orphan grace, the incomplete-archive gate.
public enum ChatArchiveLogic {

    /// One (role, content) pair as the archive hash sees it.
    public struct WireMessage: Equatable, Sendable {
        public let role: String
        public let content: String
        public init(role: String, content: String) { self.role = role; self.content = content }
    }

    /// SHA-256 over the ordered messages, each field written as `<utf8 byte length>:<value>`
    /// (role, then content), so no two lists share a byte stream. Byte-identical to the
    /// server's `archiveHash` (extension/kb/chat-lifecycle.mjs, schema/http/lifecycle.schema.json).
    /// An empty list is the SHA-256 of the empty string.
    public static func archiveHash(_ messages: [WireMessage]) -> String {
        var h = SHA256()
        for m in messages {
            let r = Data(m.role.utf8), c = Data(m.content.utf8)
            h.update(data: Data("\(r.count):".utf8)); h.update(data: r)
            h.update(data: Data("\(c.count):".utf8)); h.update(data: c)
        }
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: verify before purge (Mac chats, plan 3.2)

    public struct FileFacts: Equatable, Sendable {
        public var exists: Bool
        public var decoded: Bool
        public var messageCount: Int
        public var lastUsedAt: Date?
        /// False when the file is stamped with a different user than the one purging.
        public var ownedByCurrentUser: Bool
        public init(exists: Bool, decoded: Bool, messageCount: Int, lastUsedAt: Date?, ownedByCurrentUser: Bool = true) {
            self.exists = exists; self.decoded = decoded; self.messageCount = messageCount
            self.lastUsedAt = lastUsedAt; self.ownedByCurrentUser = ownedByCurrentUser
        }
    }

    public struct EngineFacts: Equatable, Sendable {
        public var held: Bool
        public var running: Bool
        public var messageCount: Int?
        public init(held: Bool = false, running: Bool = false, messageCount: Int? = nil) {
            self.held = held; self.running = running; self.messageCount = messageCount
        }
    }

    public enum SkipReason: String, Equatable, Sendable {
        case fileMissing, fileUnreadable, emptyFile, ownedByOtherUser
        case engineRunning, engineHolds, engineCountMismatch, fileOlderThanServer
    }

    public enum PurgeVerdict: Equatable, Sendable {
        case purge
        case skip(SkipReason)
    }

    /// The engine persists at most this many messages (`ChatEngine.persistedMessageCap`).
    public static let engineMessageCap = 500
    /// How much older than the server's last use of the chat the file may look before the
    /// purge is refused (the file is written when a turn ends, the server stamps the turn).
    public static let fileAgeTolerance: TimeInterval = 120

    /// May the server working state of a Mac chat be purged? Only when the Mac file is the
    /// verified transcript. `inQuit` means the caller already flushed every engine to disk,
    /// so an engine that holds the chat must agree with the file on how many messages it has;
    /// at the start sweep a held chat is left alone (the user may be about to continue it).
    public static func verdictForPurge(file: FileFacts, serverUpdatedAt: Date?, engine: EngineFacts,
                                       inQuit: Bool) -> PurgeVerdict {
        guard file.exists else { return .skip(.fileMissing) }
        guard file.decoded else { return .skip(.fileUnreadable) }
        guard file.ownedByCurrentUser else { return .skip(.ownedByOtherUser) }
        if engine.running { return .skip(.engineRunning) }
        if engine.held && !inQuit { return .skip(.engineHolds) }
        guard file.messageCount > 0 else { return .skip(.emptyFile) }
        if engine.held, let count = engine.messageCount {
            // A file already over the cap is an archived chat written whole; the engine holds it whole too.
            let expected = file.messageCount > engineMessageCap ? count : min(count, engineMessageCap)
            if file.messageCount != expected { return .skip(.engineCountMismatch) }
        }
        if let server = serverUpdatedAt, let used = file.lastUsedAt,
           used < server.addingTimeInterval(-fileAgeTolerance) {
            return .skip(.fileOlderThanServer)
        }
        return .purge
    }

    /// The server stamps `datetime('now')`: "YYYY-MM-DD HH:MM:SS" in UTC (also accepts ISO 8601).
    public static func parseServerTime(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        if let d = f.date(from: s) { return d }
        return ISO8601DateFormatter().date(from: s)
    }

    // MARK: orphans (working state with no Mac file)

    /// Server working state whose Mac file does not exist is reported, and purged only after
    /// this long (a user delete whose tombstone was lost would explain it).
    public static let orphanGrace: TimeInterval = 7 * 24 * 3600

    /// Anchored on the FIRST time this Mac saw the orphan, never on the server's timestamp: a chat that was idle for
    /// a month still gets its full 7 days from the moment the Mac first noticed the file was missing.
    public static func orphanIsDue(firstSeen: Date, now: Date) -> Bool {
        now.timeIntervalSince(firstSeen) >= orphanGrace
    }

    // MARK: extension chat archive

    /// How long an extension chat may sit idle on the server before it is archived while the app runs (C14).
    public static let idleArchiveAfter: TimeInterval = 30 * 60

    public static func isIdle(serverUpdatedAt: Double, now: Date) -> Bool {
        now.timeIntervalSince1970 - serverUpdatedAt >= idleArchiveAfter
    }

    public enum ExistingFileRule: Equatable, Sendable {
        /// No Mac file: write one.
        case write
        /// The Mac file is the archive already (its hash equals what the server holds): go to commit.
        case alreadyMatches
        /// The Mac file is an OLDER SNAPSHOT of this chat (every message of it is, in order, the start of what the
        /// server holds): replacing it loses nothing.
        case overwrite
        /// The Mac file differs from the server's rows in any other way (it has messages the server lacks, or other
        /// content): never overwritten; both are kept and it is surfaced.
        case conflict
    }

    /// What to do when `sessions/<id>.json` already exists while the server still holds rows (C6, C15). A differing
    /// file is a conflict, except a strict prefix of the server's messages that this protocol wrote.
    public static func ruleForExistingFile(exists: Bool, fileOrigin: String?, fileIsPrefixOfServer: Bool,
                                           fileHash: String, serverHash: String) -> ExistingFileRule {
        guard exists else { return .write }
        if fileHash == serverHash { return .alreadyMatches }
        if fileOrigin == "extension", fileIsPrefixOfServer { return .overwrite }
        return .conflict
    }

    /// True when `file` is a (possibly equal-length) prefix of `server`, message by message.
    public static func isPrefix(_ file: [WireMessage], of server: [WireMessage]) -> Bool {
        file.count <= server.count && zip(file, server).allSatisfy { $0 == $1 }
    }

    /// Roles the Mac chat model can hold losslessly. A server `system` message cannot be
    /// stored without changing what the hash covers, so that chat is not archived (rows stay).
    public static func roleIsArchivable(_ role: String) -> Bool { role == "user" || role == "assistant" }

    // MARK: delete everywhere

    /// Retry cadence is the start of the app (plus the quit sweep); this is only the age after which a
    /// tombstone that still has not landed is flagged to the user.
    public static let staleTombstoneAfter: TimeInterval = 7 * 24 * 3600
}

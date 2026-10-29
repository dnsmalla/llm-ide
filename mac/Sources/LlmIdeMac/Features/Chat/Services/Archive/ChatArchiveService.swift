import Foundation
import os.log

/// What the archive service asks of the server (the lifecycle routes, plan 4.1). A protocol so
/// the crash-table tests inject a failure at each step with a fake; `LlmIdeAPIClient` conforms below.
protocol ChatArchiveRemote: Sendable {
    func workingState() async throws -> LlmIdeAPIClient.WorkingStateResult
    func recordReceipt(chatSessionId: String, hash: String, count: Int) async throws
    /// Working state only. Throws `.noReceipt` when any chat lacks a receipt (nothing purged then).
    func purgeWorkingState(chatSessionIds: [String]) async throws -> Int
    func extensionChats() async throws -> [LlmIdeAPIClient.ServerChatSummary]
    func beginArchive(chatSessionId: String, after: Int?, fence: Int?) async throws -> LlmIdeAPIClient.ArchiveSnapshot
    func commitArchive(chatSessionId: String, fence: Int, hash: String,
                       acceptIncomplete: Bool) async throws -> LlmIdeAPIClient.ArchiveCommitResult
    func requestSessionPurge(chatSessionId: String) async throws -> LlmIdeAPIClient.SessionPurgeResult
}

/// The server's refusals the archive protocol reacts to, mapped from HTTP status + code.
enum ChatArchiveRemoteError: Error, Equatable {
    case stale
    case incomplete
    case notFound
    case noReceipt
}

/// The Mac chat files, as the archive service sees them.
protocol ChatArchiveStorage: Sendable {
    func fileExists(_ id: UUID) -> Bool
    func load(_ id: UUID) -> ChatSession?
    /// Throws when the write did not land (disk full).
    func write(_ session: ChatSession) throws
    func delete(_ id: UUID)
}

struct FileChatArchiveStorage: ChatArchiveStorage {
    func fileExists(_ id: UUID) -> Bool { ChatSessionStore.fileExists(id: id) }
    func load(_ id: UUID) -> ChatSession? { ChatSessionStore.load(id: id) }
    func write(_ session: ChatSession) throws { try ChatSessionStore.saveOrThrow(session, touch: false) }
    func delete(_ id: UUID) { ChatSessionStore.deleteQuietly(id: id) }
}

extension LlmIdeAPIClient: ChatArchiveRemote {
    func workingState() async throws -> WorkingStateResult { try await chatWorkingState() }
    func recordReceipt(chatSessionId: String, hash: String, count: Int) async throws {
        try await recordArchiveReceipt(chatSessionId: chatSessionId, hash: hash, count: count)
    }
    func purgeWorkingState(chatSessionIds: [String]) async throws -> Int {
        do { return try await purgeChatWorkingState(chatSessionIds: chatSessionIds) }
        catch APIError.http(409, "NO_RECEIPT", _, _) { throw ChatArchiveRemoteError.noReceipt }
    }
    func extensionChats() async throws -> [ServerChatSummary] { try await listExtensionChats() }
    func beginArchive(chatSessionId: String, after: Int?, fence: Int?) async throws -> ArchiveSnapshot {
        do { return try await archiveBegin(chatSessionId: chatSessionId, after: after, fence: fence) }
        catch APIError.http(409, "ARCHIVE_STALE", _, _) { throw ChatArchiveRemoteError.stale }
        catch APIError.http(404, _, _, _) { throw ChatArchiveRemoteError.notFound }
    }
    func commitArchive(chatSessionId: String, fence: Int, hash: String,
                       acceptIncomplete: Bool) async throws -> ArchiveCommitResult {
        do {
            return try await archiveCommit(chatSessionId: chatSessionId, fence: fence, hash: hash,
                                           acceptIncomplete: acceptIncomplete)
        }
        catch APIError.http(409, "ARCHIVE_STALE", _, _) { throw ChatArchiveRemoteError.stale }
        catch APIError.http(409, "INCOMPLETE_ARCHIVE", _, _) { throw ChatArchiveRemoteError.incomplete }
        catch APIError.http(404, _, _, _) { throw ChatArchiveRemoteError.notFound }
    }
    func requestSessionPurge(chatSessionId: String) async throws -> SessionPurgeResult {
        try await queueSessionPurge(chatSessionId: chatSessionId, reason: "user_delete")
    }
}

enum ChatArchiveOutcome: Equatable {
    case committed
    case alreadyArchived
    /// `shadow`: the file was written and verified; nothing was deleted on the server.
    case shadowWritten
    /// The live store dropped messages (caps); the file is written, the rows stay until the user accepts.
    case incomplete(pruned: Int, truncated: Int)
    /// A Mac file with this id holds messages the server does not; both are kept.
    case conflictKept
    case unsupportedRole
    case invalidId
    case goneOnServer
    case deletedByUser
    case skippedBusy
    case userChanged
    case staleGaveUp
    case failed(String)
}

struct ChatQuitReport: Equatable {
    /// Mac chats whose working state was purged.
    var purged: [String] = []
    /// Mac chats left alone and why (the working state stays; the sweep retries).
    var skipped: [String: String] = [:]
    var archivedExtension: [String: ChatArchiveOutcome] = [:]
    var errors: [String] = []
}

enum ChatTombstoneOutcome: Equatable {
    case done
    /// The server queued it (`pending`/`failed`): the local entry stays, the next start re-sends it.
    case queued
    case unreachable
}

/// The live-then-archive chat lifecycle (plan 3.2-3.5, Phase 4). One actor, so the quit sequence, the
/// start sweep, the idle archive and a user delete never run two steps of the same chat at once.
///
/// Invariants (each one has a test):
/// - Never delete before verify, and never delete the only copy. A Mac chat's working state is purged only
///   after its file is verified and a receipt is recorded (`ChatArchiveLogic.verdictForPurge`); an extension
///   chat's rows are deleted by the server only against the hash the Mac recomputed from the file it wrote.
/// - `off`: every entry point returns without touching anything. `shadow`: files are written and receipts are
///   recorded, NOTHING is deleted. `on`: the full behaviour.
/// - Every operation is bound to the user who started it; a sign-out or account switch aborts it before any
///   server call that deletes.
actor ChatArchiveService {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "ChatArchive")

    struct Deps: Sendable {
        var remote: ChatArchiveRemote
        var storage: ChatArchiveStorage
        var pending: ChatArchivePendingStore
        var mode: @Sendable () -> LiveThenArchiveMode
        var currentUser: @Sendable () -> String?
        /// What the engine registry knows about a chat (hops to the main actor).
        var engineFacts: @Sendable (UUID) async -> ChatArchiveLogic.EngineFacts
        /// The project an archived extension chat is filed under when the server row names none.
        var activeProjectId: @Sendable () async -> String?
        var now: @Sendable () -> Date
    }

    private let deps: Deps
    private var inFlight: Set<String> = []
    private var epoch = 0
    /// Extension chats waiting for the user to accept an incomplete archive.
    private(set) var needsDecision: [String: ChatArchiveOutcome] = [:]

    init(_ deps: Deps) { self.deps = deps }

    /// A definitive sign-out or account switch: anything in flight aborts before its next deleting call.
    func signedOut() { epoch += 1 }

    var isActive: Bool { deps.mode() != .off }

    // MARK: - Facts

    private func fileFacts(_ id: UUID, user: String) -> (ChatArchiveLogic.FileFacts, ChatSession?) {
        guard deps.storage.fileExists(id) else {
            return (.init(exists: false, decoded: false, messageCount: 0, lastUsedAt: nil), nil)
        }
        guard let s = deps.storage.load(id) else {
            return (.init(exists: true, decoded: false, messageCount: 0, lastUsedAt: nil), nil)
        }
        let owned = s.ownerUserId == nil || s.ownerUserId == user
        return (.init(exists: true, decoded: true, messageCount: s.messages.count, lastUsedAt: s.lastUsedAt,
                      ownedByCurrentUser: owned), s)
    }

    static func wire(_ messages: [ChatMessage]) -> [ChatArchiveLogic.WireMessage] {
        messages.map { m in
            // Tool-result acknowledgements travel as user turns on the wire (ChatMessage.wireTurn).
            .init(role: m.role == .assistant ? "assistant" : "user", content: m.content)
        }
    }

    // MARK: - Quit / sweep: Mac chats (plan 3.2)

    /// Verify every Mac chat the server holds working state for, record a receipt for each verified one, and (mode
    /// `on`) purge its working state. `inQuit`: the caller flushed all engines first. Bounded concurrency 4; stops
    /// starting new work when the surrounding task is cancelled (the quit cap).
    func archiveMacChats(inQuit: Bool) async -> ChatQuitReport {
        var report = ChatQuitReport()
        let mode = deps.mode()
        guard mode != .off, let user = deps.currentUser() else { return report }
        let myEpoch = epoch

        let state: LlmIdeAPIClient.WorkingStateResult
        do { state = try await deps.remote.workingState() }
        catch { report.errors.append("working-state: \(error)"); return report }

        // Extension chats are archived, not receipt-verified against a Mac file.
        let ext = Set(((try? await deps.remote.extensionChats()) ?? []).map(\.id))
        var candidates: [(UUID, LlmIdeAPIClient.WorkingChat)] = []
        var orphanIds = Set<String>()
        for ws in state.sessions {
            guard let uuid = UUID(uuidString: ws.chatSessionId) else { report.skipped[ws.chatSessionId] = "invalidId"; continue }
            if ext.contains(ws.chatSessionId) { continue }
            if deps.pending.containsDelete(uuid) { report.skipped[ws.chatSessionId] = "deletePending"; continue }
            candidates.append((uuid, ws))
        }

        var verified: [(UUID, String, Int)] = []   // id, hash, count
        var index = 0
        while index < candidates.count {
            if Task.isCancelled { break }
            let chunk = candidates[index..<min(index + 4, candidates.count)]
            index += chunk.count
            let results = await withTaskGroup(of: (UUID, Verification).self) { group in
                for (uuid, ws) in chunk {
                    group.addTask { [self] in (uuid, await verifyAndReceipt(uuid, ws, user: user, inQuit: inQuit,
                                                                           recordReceipt: true)) }
                }
                var out: [(UUID, Verification)] = []
                for await r in group { out.append(r) }
                return out
            }
            for (uuid, v) in results {
                switch v {
                case .verified(let hash, let count): verified.append((uuid, hash, count))
                case .skipped(let why): report.skipped[uuid.uuidString] = why
                case .orphan: orphanIds.insert(uuid.uuidString); report.skipped[uuid.uuidString] = "orphan"
                case .error(let e): report.errors.append("\(uuid): \(e)"); report.skipped[uuid.uuidString] = "error"
                }
            }
        }

        // Orphans: the Mac file is gone and no tombstone exists (the reverse sweep, plan 3.5 step 4).
        deps.pending.retainOrphans(orphanIds)
        if mode == .on, epoch == myEpoch, deps.currentUser() == user {
            for id in orphanIds {
                let first = deps.pending.orphanFirstSeen(id, now: deps.now())
                let server = state.sessions.first { $0.chatSessionId == id }.flatMap { ChatArchiveLogic.parseServerTime($0.updatedAt) }
                guard ChatArchiveLogic.orphanIsDue(firstSeen: first, serverUpdatedAt: server, now: deps.now()) else { continue }
                if let r = try? await deps.remote.requestSessionPurge(chatSessionId: id), r.purged == "done" {
                    report.purged.append(id)
                }
            }
        } else {
            for id in orphanIds { _ = deps.pending.orphanFirstSeen(id, now: deps.now()) }
        }

        guard mode == .on, !verified.isEmpty else { return report }
        guard epoch == myEpoch, deps.currentUser() == user else {
            report.errors.append("user changed before purge")
            return report
        }
        // Re-check engines right before the delete: at the sweep a chat may have been opened since verify.
        var toPurge: [String] = []
        for (uuid, _, _) in verified {
            let e = await deps.engineFacts(uuid)
            if e.running || (e.held && !inQuit) { report.skipped[uuid.uuidString] = "heldBeforePurge"; continue }
            toPurge.append(uuid.uuidString)
        }
        var i = 0
        while i < toPurge.count, !Task.isCancelled {
            let batch = Array(toPurge[i..<min(i + 100, toPurge.count)])
            i += batch.count
            do {
                _ = try await deps.remote.purgeWorkingState(chatSessionIds: batch)
                report.purged.append(contentsOf: batch)
            } catch ChatArchiveRemoteError.noReceipt {
                // A receipt the server does not hold refuses the whole batch; retry one by one so the rest still clear.
                for id in batch where !Task.isCancelled {
                    do { _ = try await deps.remote.purgeWorkingState(chatSessionIds: [id]); report.purged.append(id) }
                    catch { report.skipped[id] = "noReceipt" }
                }
            } catch {
                report.errors.append("purge: \(error)")
            }
        }
        return report
    }

    private enum Verification {
        case verified(hash: String, count: Int)
        case skipped(String)
        case orphan
        case error(String)
    }

    private func verifyAndReceipt(_ uuid: UUID, _ ws: LlmIdeAPIClient.WorkingChat, user: String, inQuit: Bool,
                                  recordReceipt: Bool) async -> Verification {
        if inFlight.contains(ws.chatSessionId) { return .skipped("busy") }
        let (file, session) = fileFacts(uuid, user: user)
        let engine = await deps.engineFacts(uuid)
        let verdict = ChatArchiveLogic.verdictForPurge(
            file: file, serverUpdatedAt: ChatArchiveLogic.parseServerTime(ws.updatedAt), engine: engine, inQuit: inQuit)
        switch verdict {
        case .skip(.fileMissing): return .orphan
        case .skip(let why): return .skipped(why.rawValue)
        case .purge: break
        }
        guard let session else { return .skipped("fileUnreadable") }
        let hash = ChatArchiveLogic.archiveHash(Self.wire(session.messages))
        guard recordReceipt else { return .verified(hash: hash, count: session.messages.count) }
        do {
            try await deps.remote.recordReceipt(chatSessionId: ws.chatSessionId, hash: hash, count: session.messages.count)
            return .verified(hash: hash, count: session.messages.count)
        } catch {
            return .error("receipt: \(error)")
        }
    }

    // MARK: - Extension chats (plan 3.3)

    /// Archive every live extension chat (quit, sweep). Sequential: there is normally one.
    func archiveExtensionChats(onlyIdleSince idle: Bool = false) async -> [String: ChatArchiveOutcome] {
        guard deps.mode() != .off, deps.currentUser() != nil else { return [:] }
        guard let chats = try? await deps.remote.extensionChats() else { return [:] }
        var out: [String: ChatArchiveOutcome] = [:]
        for chat in chats {
            if Task.isCancelled { break }
            if idle, !ChatArchiveLogic.isIdle(serverUpdatedAt: chat.updatedAt, now: deps.now()) { continue }
            out[chat.id] = await archiveExtensionChat(chat.id)
        }
        return out
    }

    /// The fenced archive of one extension chat. Safe to cut at any step: see the crash table (plan 3.4, C5-C7, C9).
    func archiveExtensionChat(_ serverId: String, acceptIncomplete: Bool = false) async -> ChatArchiveOutcome {
        let mode = deps.mode()
        guard mode != .off else { return .failed("lta.mode is off") }
        guard let owner = deps.currentUser() else { return .failed("signed out") }
        guard let uuid = UUID(uuidString: serverId) else { return .invalidId }
        guard inFlight.insert(serverId).inserted else { return .skippedBusy }
        defer { inFlight.remove(serverId) }
        let myEpoch = epoch

        func stillMine() -> Bool { epoch == myEpoch && deps.currentUser() == owner }

        for _ in 1...3 {
            if Task.isCancelled { return .failed("cancelled") }
            if deps.pending.containsDelete(uuid) { return .deletedByUser }

            // 1. begin, paged under one fence.
            var snap: LlmIdeAPIClient.ArchiveSnapshot
            var messages: [LlmIdeAPIClient.ArchiveMessage]
            do {
                snap = try await deps.remote.beginArchive(chatSessionId: serverId, after: nil, fence: nil)
                messages = snap.messages
                var next = snap.nextAfter
                while let after = next {
                    let page = try await deps.remote.beginArchive(chatSessionId: serverId, after: after, fence: snap.fence)
                    messages += page.messages
                    next = page.nextAfter
                }
            } catch ChatArchiveRemoteError.stale {
                continue
            } catch ChatArchiveRemoteError.notFound {
                return .goneOnServer
            } catch {
                return .failed("begin: \(error)")
            }
            guard messages.allSatisfy({ ChatArchiveLogic.roleIsArchivable($0.role) }) else { return .unsupportedRole }

            let incoming = messages.map { ChatArchiveLogic.WireMessage(role: $0.role, content: $0.content) }
            let incomingHash = ChatArchiveLogic.archiveHash(incoming)

            // 2. what is already on the Mac under this id (C6, C15).
            let existing: ChatSession? = deps.storage.fileExists(uuid) ? deps.storage.load(uuid) : nil
            if deps.storage.fileExists(uuid), existing == nil { return .conflictKept }   // unreadable: never overwrite
            let existingHash = existing.map { ChatArchiveLogic.archiveHash(Self.wire($0.messages)) } ?? ""
            let rule = ChatArchiveLogic.ruleForExistingFile(
                exists: existing != nil, fileOrigin: existing?.origin, fileArchiveHash: existing?.archive?.hash,
                fileMessageCount: existing?.messages.count ?? 0, fileHash: existingHash,
                serverHash: incomingHash, serverCount: messages.count)
            if rule == .conflict { return .conflictKept }

            // 3. write, read back, recompute from the FILE.
            var fileHash = existingHash
            if rule == .write || rule == .overwrite {
                let project = await deps.activeProjectId()
                var session = ChatSession(
                    id: uuid, scope: .quick, title: snap.session.title.isEmpty ? "New chat" : snap.session.title,
                    createdAt: Date(timeIntervalSince1970: snap.session.createdAt),
                    lastUsedAt: Date(timeIntervalSince1970: snap.session.updatedAt),
                    messages: messages.map {
                        ChatMessage(role: $0.role == "assistant" ? .assistant : .user, content: $0.content,
                                    status: .done, createdAt: Date(timeIntervalSince1970: $0.createdAt))
                    },
                    projectId: snap.session.projectId ?? project,
                    ownerUserId: owner, origin: "extension",
                    archive: .init(hash: incomingHash, count: messages.count))
                session.engine = nil
                do { try deps.storage.write(session) }
                catch { return .failed("write: \(error.localizedDescription)") }   // C9: rows intact, nothing sent
                guard let back = deps.storage.load(uuid) else { return .failed("read-back: file missing or unreadable") }
                fileHash = ChatArchiveLogic.archiveHash(Self.wire(back.messages))
                guard back.messages.count == messages.count, fileHash == incomingHash else {
                    return .failed("read-back: the file does not match what the server sent")
                }
            }

            // 4. checks that may have changed while we worked.
            guard stillMine() else { return .userChanged }
            if deps.pending.containsDelete(uuid) {
                if rule != .alreadyMatches { deps.storage.delete(uuid) }
                return .deletedByUser
            }
            if mode == .shadow { return .shadowWritten }
            if snap.incomplete.incomplete, !acceptIncomplete {
                let o = ChatArchiveOutcome.incomplete(pruned: snap.incomplete.prunedMessages, truncated: snap.incomplete.truncatedMessages)
                needsDecision[serverId] = o
                return o
            }

            // 5. commit against the hash OF THE FILE.
            do {
                let r = try await deps.remote.commitArchive(chatSessionId: serverId, fence: snap.fence, hash: fileHash,
                                                            acceptIncomplete: acceptIncomplete)
                needsDecision[serverId] = nil
                // A delete that raced the commit: honour it (the rows are gone either way).
                if deps.pending.containsDelete(uuid) { deps.storage.delete(uuid) }
                return r.status == "deleted" ? .committed : .alreadyArchived
            } catch ChatArchiveRemoteError.stale {
                continue                                            // an append raced in: begin again, same file name
            } catch ChatArchiveRemoteError.incomplete {
                let o = ChatArchiveOutcome.incomplete(pruned: snap.incomplete.prunedMessages, truncated: snap.incomplete.truncatedMessages)
                needsDecision[serverId] = o
                return o
            } catch ChatArchiveRemoteError.notFound {
                return .goneOnServer
            } catch {
                return .failed("commit: \(error)")                  // C7 mirror: file stays, rows stay, the sweep retries
            }
        }
        return .staleGaveUp
    }

    /// The user accepted an incomplete archive (the caps dropped messages): commit it.
    func acceptIncomplete(_ serverId: String) async -> ChatArchiveOutcome {
        await archiveExtensionChat(serverId, acceptIncomplete: true)
    }

    // MARK: - Delete everywhere (plan 3.5)

    /// Record the intent to delete `id` BEFORE the file is removed. Durable, idempotent, synchronous.
    nonisolated func registerDeleteIntent(_ id: UUID) {
        guard deps.mode() == .on else { return }
        deps.pending.addDelete(id: id, owner: deps.currentUser(), now: deps.now())
    }

    /// Send the tombstone. The local entry is removed only when the server confirms the purge is done; any
    /// other answer (queued, down, signed out) leaves it for the next start.
    func sendTombstone(_ id: UUID) async -> ChatTombstoneOutcome {
        guard deps.mode() == .on else { return .unreachable }
        do {
            let r = try await deps.remote.requestSessionPurge(chatSessionId: id.uuidString)
            if r.purged == "done" { deps.pending.removeDelete(id); return .done }
            deps.pending.bumpAttempt(id)
            return .queued
        } catch {
            deps.pending.bumpAttempt(id)
            return .unreachable
        }
    }

    /// Start-time replay of every tombstone this user still owes, and the reverse guard: a file whose delete is
    /// pending is a resurrection (a late persist) and is removed again.
    func replayPendingDeletes() async -> [String: ChatTombstoneOutcome] {
        guard deps.mode() == .on, let user = deps.currentUser() else { return [:] }
        var out: [String: ChatTombstoneOutcome] = [:]
        for entry in deps.pending.deletes(for: user) {
            if Task.isCancelled { break }
            guard let uuid = UUID(uuidString: entry.id) else { deps.pending.removeDelete(rawId: entry.id); continue }
            if deps.storage.fileExists(uuid), inFlight.contains(entry.id) == false {
                deps.storage.delete(uuid)
            }
            out[entry.id] = await sendTombstone(uuid)
        }
        return out
    }

    // MARK: - The whole sweep

    /// The next-start recovery sweep (plan 3.2, crash table): tombstones first, then extension chats (archive before
    /// anything is deleted), then Mac chats' working state.
    func sweep() async -> ChatQuitReport {
        guard deps.mode() != .off, deps.currentUser() != nil else { return ChatQuitReport() }
        _ = await replayPendingDeletes()
        let ext = await archiveExtensionChats()
        var report = await archiveMacChats(inQuit: false)
        report.archivedExtension = ext
        return report
    }

    /// The quit sequence's server half. The caller flushed every engine to disk first.
    func quit() async -> ChatQuitReport {
        guard deps.mode() != .off, deps.currentUser() != nil else { return ChatQuitReport() }
        let ext = await archiveExtensionChats()
        var report = await archiveMacChats(inQuit: true)
        report.archivedExtension = ext
        return report
    }

    /// The periodic idle archive (C14): extension chats idle for 30 minutes.
    func idleArchive() async -> [String: ChatArchiveOutcome] {
        await archiveExtensionChats(onlyIdleSince: true)
    }
}

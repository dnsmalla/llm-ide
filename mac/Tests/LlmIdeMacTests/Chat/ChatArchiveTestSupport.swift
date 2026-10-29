import Foundation
@testable import LlmIdeMacLib

/// A scripted server for the archive tests: faithful enough to the real routes (fence, paged begin, hash-checked commit,
/// receipts gating the purge, tombstones) that a protocol mistake shows up as a failed assertion, with a failure-injection
/// switch at every call so each row of the plan's crash table can be exercised.
final class FakeArchiveRemote: ChatArchiveRemote, @unchecked Sendable {
    struct Chat {
        var id: String
        var title = "Extension chat"
        var messages: [(role: String, content: String)]
        var fence = 0
        var lifecycle = "live"
        var pruned = 0
        var truncated = 0
        var updatedAt: Double = Date().timeIntervalSince1970
        var projectId: String?
        var surface = "extension"
    }
    struct Injected: Error, CustomStringConvertible { let call: String; var description: String { "injected failure in \(call)" } }

    private let lock = NSLock()
    var chats: [String: Chat] = [:]
    var working: [LlmIdeAPIClient.WorkingChat] = []
    var receipts: [String: (hash: String, count: Int)] = [:]
    var purgedWorkingState: [String] = []
    var tombstones: [String] = []
    var calls: [String] = []
    var pageSize = 200
    /// Call name -> throw this many times (then succeed).
    var failures: [String: Int] = [:]
    /// Call name -> (seconds) cancellable delay before answering.
    var delays: [String: Double] = [:]
    /// Run just before the named call's effect (to race something in).
    var before: [String: () -> Void] = [:]
    var purgeAnswer = "done"
    var purgeBusyIDs: Set<String> = []
    var purgeStaleIDs: Set<String> = []
    var orphanPurged: [String] = []
    var tombstoneRequestedAt: [String: Date] = [:]
    var tombstoneBusy = false
    var commitStaleTimes = 0
    var rowsAfterTombstone: Bool = false

    private func enter(_ name: String) async throws {
        lock.lock()
        calls.append(name)
        let delay = delays[name]
        let hook = before[name]
        lock.unlock()
        if let delay { try await Task.sleep(for: .seconds(delay)) }
        hook?()
        lock.lock()
        let shouldFail = (failures[name] ?? 0) > 0
        if shouldFail { failures[name]! -= 1 }
        lock.unlock()
        if shouldFail { throw Injected(call: name) }
    }

    func callCount(_ name: String) -> Int { lock.lock(); defer { lock.unlock() }; return calls.filter { $0 == name }.count }

    func workingState() async throws -> LlmIdeAPIClient.WorkingStateResult {
        try await enter("workingState")
        lock.lock(); defer { lock.unlock() }
        return .init(sessions: working, purges: .init(pending: 0, failed: []))
    }

    func recordReceipt(chatSessionId: String, hash: String, count: Int) async throws {
        try await enter("recordReceipt")
        lock.lock(); receipts[chatSessionId] = (hash, count); lock.unlock()
    }

    func purgeWorkingState(chatSessionIds: [String], orphan: Bool) async throws -> LlmIdeAPIClient.WorkingStatePurgeResult {
        try await enter("purgeWorkingState")
        lock.lock(); defer { lock.unlock() }
        if !orphan, chatSessionIds.contains(where: { receipts[$0] == nil }) { throw ChatArchiveRemoteError.noReceipt }
        var n = 0
        var busy: [String] = [], stale: [String] = [], refused: [String] = []
        for id in chatSessionIds {
            if orphan, chats[id] != nil { refused.append(id); continue }
            if purgeBusyIDs.contains(id) { busy.append(id); continue }
            if purgeStaleIDs.contains(id) { stale.append(id); continue }
            if let i = working.firstIndex(where: { $0.chatSessionId == id }) { working.remove(at: i); n += 1 }
            purgedWorkingState.append(id)
            if orphan { orphanPurged.append(id) }
        }
        return .init(purged: n, busy: busy, staleReceipt: stale, refused: orphan ? refused : nil)
    }

    func serverChats() async throws -> [LlmIdeAPIClient.ServerChatSummary] {
        try await enter("serverChats")
        lock.lock(); defer { lock.unlock() }
        return chats.values.map { .init(id: $0.id, title: $0.title, surface: $0.surface, mode: "transcript",
                                        projectId: $0.projectId, createdAt: 1_700_000_000, updatedAt: $0.updatedAt) }
    }

    private func snapshot(_ c: Chat, page: ArraySlice<(role: String, content: String)>, startSeq: Int, next: Int?) -> LlmIdeAPIClient.ArchiveSnapshot {
        let all = ChatArchiveLogic.archiveHash(c.messages.map { .init(role: $0.role, content: $0.content) })
        return .init(
            fence: c.fence, count: c.messages.count, hash: all,
            incomplete: .init(incomplete: c.pruned > 0 || c.truncated > 0, prunedMessages: c.pruned, truncatedMessages: c.truncated),
            session: .init(id: c.id, title: c.title, surface: "extension", mode: "transcript", projectId: c.projectId,
                           createdAt: 1_700_000_000, updatedAt: c.updatedAt),
            messages: page.enumerated().map { .init(seq: startSeq + $0.offset + 1, role: $0.element.role,
                                                   content: $0.element.content, createdAt: 1_700_000_001 + Double($0.offset)) },
            nextAfter: next)
    }

    func beginArchive(chatSessionId: String, after: Int?, fence: Int?) async throws -> LlmIdeAPIClient.ArchiveSnapshot {
        try await enter("beginArchive")
        lock.lock(); defer { lock.unlock() }
        guard var c = chats[chatSessionId] else { throw ChatArchiveRemoteError.notFound }
        if after == nil { c.fence += 1; c.lifecycle = "archiving"; chats[chatSessionId] = c }
        else if c.lifecycle != "archiving" || c.fence != fence { throw ChatArchiveRemoteError.stale }
        let start = after ?? 0
        let end = min(start + pageSize, c.messages.count)
        return snapshot(c, page: c.messages[start..<end], startSeq: start, next: end < c.messages.count ? end : nil)
    }

    func commitArchive(chatSessionId: String, fence: Int, hash: String, acceptIncomplete: Bool) async throws -> LlmIdeAPIClient.ArchiveCommitResult {
        try await enter("commitArchive")
        lock.lock(); defer { lock.unlock() }
        guard let c = chats[chatSessionId] else {
            if let r = receipts[chatSessionId], r.hash == hash { return .init(deleted: false, status: "already_archived") }
            throw ChatArchiveRemoteError.notFound
        }
        if commitStaleTimes > 0 { commitStaleTimes -= 1; throw ChatArchiveRemoteError.stale }
        if c.lifecycle != "archiving" || c.fence != fence { throw ChatArchiveRemoteError.stale }
        if (c.pruned > 0 || c.truncated > 0), !acceptIncomplete { throw ChatArchiveRemoteError.incomplete }
        let digest = ChatArchiveLogic.archiveHash(c.messages.map { .init(role: $0.role, content: $0.content) })
        if digest != hash { throw ChatArchiveRemoteError.stale }
        receipts[chatSessionId] = (hash, c.messages.count)
        chats[chatSessionId] = nil
        return .init(deleted: true, status: "deleted")
    }

    func requestSessionPurge(chatSessionId: String, requestedAt: Date) async throws -> LlmIdeAPIClient.SessionPurgeResult {
        try await enter("requestSessionPurge")
        lock.lock(); defer { lock.unlock() }
        tombstones.append(chatSessionId)
        tombstoneRequestedAt[chatSessionId] = requestedAt
        if purgeAnswer == "done", !tombstoneBusy {
            working.removeAll { $0.chatSessionId == chatSessionId }
            chats[chatSessionId] = nil
        }
        return .init(queued: true, purged: tombstoneBusy ? "pending" : purgeAnswer, busy: tombstoneBusy ? true : nil, skippedReused: nil)
    }

    // helpers
    func addWorking(_ id: UUID, updatedAt: Date = Date(), facts: Int = 1) {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        lock.lock()
        working.append(.init(chatSessionId: id.uuidString, sdkSession: "sdk-\(id.uuidString.prefix(4))", factCount: facts,
                             updatedAt: f.string(from: updatedAt)))
        lock.unlock()
    }
    func addExtensionChat(_ id: UUID, _ messages: [(String, String)], updatedAt: Date = Date()) {
        lock.lock()
        chats[id.uuidString] = Chat(id: id.uuidString, messages: messages.map { (role: $0.0, content: $0.1) },
                                    updatedAt: updatedAt.timeIntervalSince1970)
        lock.unlock()
    }
    func workingIDs() -> Set<String> { lock.lock(); defer { lock.unlock() }; return Set(working.map(\.chatSessionId)) }
}

/// A storage that delegates to the real chat store, with switches to make a write fail (disk full) or a delete fail.
final class FlakyArchiveStorage: ChatArchiveStorage, @unchecked Sendable {
    private let real = FileChatArchiveStorage()
    private let lock = NSLock()
    var failWrites = false
    var writes = 0
    /// nil = ask the real store; otherwise the answer `storeLooksHealthy` gives.
    var healthyOverride: Bool?
    func fileExists(_ id: UUID) -> Bool { real.fileExists(id) }
    func load(_ id: UUID) -> ChatSession? { real.load(id) }
    func write(_ session: ChatSession) throws {
        lock.lock(); let fail = failWrites; writes += 1; lock.unlock()
        if fail { throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC), userInfo: [NSLocalizedDescriptionKey: "No space left on device"]) }
        try real.write(session)
    }
    func delete(_ id: UUID) { real.delete(id) }
    func storeLooksHealthy() -> Bool { healthyOverride ?? real.storeLooksHealthy() }
}

/// Mutable knobs a test turns while a service runs.
final class ArchiveKnobs: @unchecked Sendable {
    private let lock = NSLock()
    private var _mode: LiveThenArchiveMode = .on
    private var _user: String? = "user-A"
    private var _engines: [UUID: ChatArchiveLogic.EngineFacts] = [:]
    private var _now = Date()
    var mode: LiveThenArchiveMode { get { lock.lock(); defer { lock.unlock() }; return _mode } set { lock.lock(); _mode = newValue; lock.unlock() } }
    var user: String? { get { lock.lock(); defer { lock.unlock() }; return _user } set { lock.lock(); _user = newValue; lock.unlock() } }
    var now: Date { get { lock.lock(); defer { lock.unlock() }; return _now } set { lock.lock(); _now = newValue; lock.unlock() } }
    func engine(_ id: UUID) -> ChatArchiveLogic.EngineFacts { lock.lock(); defer { lock.unlock() }; return _engines[id] ?? .init() }
    func setEngine(_ id: UUID, _ f: ChatArchiveLogic.EngineFacts) { lock.lock(); _engines[id] = f; lock.unlock() }
}

/// One test's world: a temp chat store (under the global store gate), a fake server and a service over them.
@MainActor
final class ArchiveRig {
    let dir: URL
    let remote = FakeArchiveRemote()
    let storage = FlakyArchiveStorage()
    let knobs = ArchiveKnobs()
    let pending: ChatArchivePendingStore
    private(set) var service: ChatArchiveService!

    static func make() async -> ArchiveRig {
        await ChatStoreOverrideGate.shared.acquire()
        return ArchiveRig()
    }

    private init() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("lta-archive-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = dir
        ChatSessionStore.Tags.resetCache()
        let d = dir
        pending = ChatArchivePendingStore(directory: { d })
        service = makeService()
    }

    func makeService() -> ChatArchiveService {
        let k = knobs
        return ChatArchiveService(.init(
            remote: remote, storage: storage, pending: pending,
            mode: { k.mode }, currentUser: { k.user },
            engineFacts: { id in k.engine(id) },
            activeProjectId: { "proj-1" },
            now: { k.now }))
    }

    /// Release the global store gate and clean up. Always call (use `defer`).
    func close() {
        ChatSessionStore.baseDirectoryOverride = nil
        ChatSessionStore.ownership = nil
        ChatSessionStore.onUserDelete = nil
        ChatSessionStore.Tags.resetCache()
        ChatArchiveHost.shared.resetForTesting()
        try? FileManager.default.removeItem(at: dir)
        ChatStoreOverrideGate.shared.release()
    }

    /// A Mac chat file as the engine would have written it.
    @discardableResult
    func macChat(_ id: UUID = UUID(), turns: Int = 2, owner: String? = nil, lastUsed: Date = Date(), scope: ChatScope = .quick) -> ChatSession {
        var msgs: [ChatMessage] = []
        for i in 0..<turns {
            msgs.append(ChatMessage(role: .user, content: "question \(i)", status: .done, createdAt: lastUsed))
            msgs.append(ChatMessage(role: .assistant, content: "answer \(i) ✓", status: .done, createdAt: lastUsed))
        }
        let s = ChatSession(id: id, scope: scope, title: "Mac chat", createdAt: lastUsed, lastUsedAt: lastUsed,
                            messages: msgs, projectId: "proj-1", ownerUserId: owner)
        try? ChatSessionStore.saveOrThrow(s, touch: false)
        return s
    }
}

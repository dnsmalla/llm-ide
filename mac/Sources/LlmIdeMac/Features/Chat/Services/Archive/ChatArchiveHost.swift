import Foundation
import os.log

private let archiveHostLog = Logger(subsystem: "com.llmide.macapp", category: "ChatArchive")

/// What the Settings card shows (live-then-archive).
struct ChatArchiveStatus: Equatable {
    var mode: LiveThenArchiveMode
    var userId: String?
    /// Older chat files with no owner, awaiting an explicit claim.
    var unowned: Int
    /// Extension chats kept on the server because the archive is incomplete or a Mac file differs.
    var attention: Int
    /// Delete tombstones the server has not confirmed yet.
    var pendingDeletes: Int
}

/// What the attention list needs from the host; `ChatArchiveHost` conforms, tests substitute a fake.
@MainActor
protocol ChatArchiveDecisionHosting: AnyObject {
    func attentionItems() async -> [ChatArchiveAttentionItem]
    func acceptIncompleteArchive(_ serverChatId: String) async -> ChatArchiveOutcome
    func dismissAttention(_ serverChatId: String) async
}

/// Retry schedule for the start sweep: a backend that is not up yet must not cost the whole recovery.
enum ChatArchiveBackoff {
    /// 5 s, then roughly tripling to a 5 minute cap, for a bounded number of tries.
    static let defaultDelays: [TimeInterval] = [5, 15, 45, 135, 300, 300, 300, 300, 300, 300]

    /// Run `attempt` (true = the sweep completed) until it completes, the schedule is exhausted, or the task is
    /// cancelled. Returns the number of attempts made. `sleep` is injectable for tests.
    static func run(delays: [TimeInterval] = defaultDelays,
                    sleep: @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) },
                    attempt: @Sendable () async -> Bool) async -> Int {
        var tries = 0
        for delay in delays {
            if Task.isCancelled { return tries }
            await sleep(delay)
            if Task.isCancelled { return tries }
            tries += 1
            if await attempt() { return tries }
        }
        return tries
    }
}

/// The app-side home of the live-then-archive chat lifecycle: owns the `ChatArchiveService`, wires the quit hook,
/// the start sweep, the idle timer and the delete-everywhere intent, and tells the chat store who is signed in.
///
/// `lta.mode = off` (the default): no service, no quit hook, no delete tombstone; the only thing installed is the
/// owner filter, which hides a chat file stamped with another user (such files exist only after the mode was `on`).
@MainActor
final class ChatArchiveHost: ChatArchiveDecisionHosting {
    static let shared = ChatArchiveHost()
    private(set) var service: ChatArchiveService?
    private(set) var mode: LiveThenArchiveMode = .off
    /// The signed-in user, mirrored thread-safely (the session store is main-actor; the archive actor is not).
    private let currentUserBox = LockedString()
    private var idleTask: Task<Void, Never>?
    private var sweepTask: Task<Void, Never>?
    private var installed = false

    /// Last report of the quit or sweep, for diagnostics and tests.
    private(set) var lastReport: ChatQuitReport?
    /// How many sweep attempts the last start needed (diagnostics).
    private(set) var sweepAttempts = 0

    /// Sign-out keeps the chat files (never wipes) in `shadow` and `on`.
    var keepsChatsOnSignOut: Bool { mode != .off && service != nil }
    /// True when a user delete is cleaned up through the tombstone path instead of the best-effort calls.
    var ownsDelete: Bool { mode == .on && service != nil }

    /// Wire everything for `mode`. Call once at boot.
    func install(api: LlmIdeAPIClient, mode: LiveThenArchiveMode,
                 activeProjectId: @escaping @Sendable () async -> String?) {
        guard !installed else { return }
        installed = true
        self.mode = mode
        let box = currentUserBox
        let user: @Sendable () -> String? = { box.get() }
        // Another user's chat file is hidden and not loadable, in every mode (files tagged with an owner only exist
        // once `shadow` or `on` has stamped them).
        ChatSessionStore.ownership = .init(stamp: mode != .off, filter: true, currentUserId: user)
        guard mode != .off else { return }
        let service = ChatArchiveService(.init(
            remote: api,
            storage: FileChatArchiveStorage(),
            pending: ChatArchivePendingStore(directory: { ChatSessionStore.supportDirectory }),
            mode: { mode },
            currentUser: user,
            engineFacts: { id in await MainActor.run { ChatEngineRegistry.shared.archiveFacts(for: id) } },
            activeProjectId: activeProjectId,
            now: { Date() }))
        self.service = service
        if mode == .on {
            ChatSessionStore.onUserDelete = { id in service.registerDeleteIntent(id) }
        }
        AppTerminationHooks.registerAsync("chat archive") { [weak self] in
            // Persist every engine's unwritten tail FIRST: the verify below reads the files.
            ChatEngineRegistry.shared.flushAll()
            self?.lastReport = await service.quit()
        }
    }

    /// The session became authenticated. Runs in every mode: it tells the store who is signed in and reloads the
    /// lists. In `shadow`/`on` it also starts the recovery sweep (retried with backoff until the backend is up and
    /// the sweep completes) and the idle archive. Nothing is claimed: older chats stay as they are until the user
    /// presses "Claim".
    func signedIn(userId: String) {
        currentUserBox.set(userId)
        ChatEngineRegistry.shared.refreshSessionLists()
        guard let service else { return }
        Task.detached(priority: .utility) { ChatSessionStore.pruneStaleTags() }
        sweepTask?.cancel()
        sweepTask = Task { [self] in
            let tries = await ChatArchiveBackoff.run {
                let report = await service.sweep()
                await MainActor.run { self.lastReport = report }
                archiveHostLog.info("lta sweep: completed=\(report.completed) purged=\(report.purged.count) skipped=\(report.skipped.count) errors=\(report.errors.count, privacy: .public)")
                return report.completed
            }
            await MainActor.run { self.sweepAttempts = tries }
        }
        idleTask?.cancel()
        idleTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(300))
                guard !Task.isCancelled else { return }
                _ = await service.idleArchive()
            }
        }
    }

    /// A definitive sign-out in `shadow`/`on` (called by the engine registry). Files stay; anything in flight aborts.
    func didSignOut() {
        sweepTask?.cancel(); sweepTask = nil
        idleTask?.cancel(); idleTask = nil
        currentUserBox.clear()
        if let service { Task { await service.signedOut() } }
    }

    /// Sign-out in `off`: only forget who was signed in.
    func clearUser() { currentUserBox.clear() }

    /// The tail of a user delete in `on`: send the tombstone (the intent was recorded before the file went).
    func finishDelete(_ id: UUID) async {
        guard let service else { return }
        service.registerDeleteIntent(id)
        _ = await service.sendTombstone(id)
    }

    // MARK: Settings card

    func status() async -> ChatArchiveStatus {
        let unowned = await Task.detached(priority: .utility) { ChatSessionStore.unownedCount() }.value
        let attention = await service?.attention().count ?? 0
        let pending = await service?.pendingDeleteCount() ?? 0
        return ChatArchiveStatus(mode: mode, userId: currentUserBox.get(), unowned: unowned, attention: attention, pendingDeletes: pending)
    }

    /// The explicit "Claim N older chats for <user>" action. Off the main actor; lists refresh after.
    @discardableResult
    func claimOlderChats() async -> Int {
        guard let user = currentUserBox.get() else { return 0 }
        let n = await Task.detached(priority: .userInitiated) { ChatSessionStore.claimUnowned(owner: user) }.value
        ChatEngineRegistry.shared.refreshSessionLists()
        return n
    }

    /// The user accepted an incomplete archive of an extension chat.
    @discardableResult
    func acceptIncompleteArchive(_ serverChatId: String) async -> ChatArchiveOutcome {
        await service?.acceptIncomplete(serverChatId) ?? .failed("archive is not running")
    }

    /// The chats waiting for a decision, for the Settings list.
    func attentionItems() async -> [ChatArchiveAttentionItem] {
        await service?.attentionItems() ?? []
    }

    /// "Keep on server": drop the chat from the list (its rows stay).
    func dismissAttention(_ serverChatId: String) async {
        await service?.dismissAttention(serverChatId)
    }

    // MARK: Test seams

    func installForTesting(mode: LiveThenArchiveMode, service: ChatArchiveService?) {
        self.mode = mode
        self.service = service
        installed = true
    }

    func resetForTesting() {
        sweepTask?.cancel(); idleTask?.cancel()
        sweepTask = nil; idleTask = nil
        service = nil
        mode = .off
        installed = false
        currentUserBox.clear()
        ChatSessionStore.ownership = nil
        ChatSessionStore.onUserDelete = nil
    }

    func setUserForTesting(_ id: String?) {
        if let id { currentUserBox.set(id) } else { currentUserBox.clear() }
    }
}

private final class LockedString: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    func set(_ v: String) { lock.lock(); value = v; lock.unlock() }
    func clear() { lock.lock(); value = nil; lock.unlock() }
    func get() -> String? { lock.lock(); defer { lock.unlock() }; return value }
}

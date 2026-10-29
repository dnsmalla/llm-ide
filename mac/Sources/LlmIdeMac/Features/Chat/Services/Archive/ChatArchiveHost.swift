import Foundation
import os.log

/// The app-side home of the live-then-archive chat lifecycle: owns the `ChatArchiveService`, wires the quit hook,
/// the start sweep, the idle timer and the delete-everywhere intent, and tells the chat store who is signed in.
///
/// `lta.mode = off` (the default): `install` does NOTHING, so the quit sequence, the delete path and the sign-out
/// wipe are exactly what they were. Shell calls `install` once at boot.
@MainActor
final class ChatArchiveHost {
    static let shared = ChatArchiveHost()
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "ChatArchive")

    private(set) var service: ChatArchiveService?
    private(set) var mode: LiveThenArchiveMode = .off
    /// The signed-in user, mirrored thread-safely (the session store is main-actor; the archive actor is not).
    private let currentUserBox = LockedString()
    private let lastUser = LockedString()
    private var idleTask: Task<Void, Never>?
    private var sweepTask: Task<Void, Never>?
    private var installed = false

    /// Last report of the quit or sweep, for diagnostics and tests.
    private(set) var lastReport: ChatQuitReport?

    /// Sign-out keeps the chat files (never wipes) only in `on`.
    var keepsChatsOnSignOut: Bool { mode == .on && service != nil }
    /// True when a user delete is cleaned up through the tombstone path instead of the best-effort calls.
    var ownsDelete: Bool { mode == .on && service != nil }

    /// Wire everything for `mode`. Call once at boot; a mode of `off` returns without touching anything.
    func install(api: LlmIdeAPIClient, mode: LiveThenArchiveMode,
                 activeProjectId: @escaping @Sendable () async -> String?) {
        guard mode != .off, !installed else { return }
        installed = true
        self.mode = mode
        let box = currentUserBox
        let user: @Sendable () -> String? = { box.get() }
        ChatSessionStore.ownership = .init(stamp: true, filter: mode == .on, currentUserId: user)
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

    /// The session became authenticated: claim unowned files for this user, run the recovery sweep (off the
    /// launch critical path) and start the idle archive. Idempotent.
    func signedIn(userId: String) {
        guard let service else { return }
        lastUser.set(userId)
        currentUserBox.set(userId)
        ChatSessionStore.stampUnowned(owner: userId)
        sweepTask?.cancel()
        sweepTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            let report = await service.sweep()
            await MainActor.run { self?.lastReport = report }
            Self.log.info("lta sweep: purged=\(report.purged.count) skipped=\(report.skipped.count) errors=\(report.errors.count)")
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

    /// A definitive sign-out (called by the engine registry in `on`). Files stay; the departing user's unowned
    /// chats are claimed so the next user never inherits them; anything in flight aborts.
    func didSignOut() {
        sweepTask?.cancel(); sweepTask = nil
        idleTask?.cancel(); idleTask = nil
        currentUserBox.clear()
        if let owner = lastUser.get() { ChatSessionStore.stampUnowned(owner: owner) }
        if let service { Task { await service.signedOut() } }
    }

    /// The tail of a user delete in `on`: send the tombstone (the intent was recorded before the file went).
    func finishDelete(_ id: UUID) async {
        guard let service else { return }
        service.registerDeleteIntent(id)
        _ = await service.sendTombstone(id)
    }

    /// Test seam: stand in for `install` with a ready service and mode (the real one is once-per-process).
    func installForTesting(mode: LiveThenArchiveMode, service: ChatArchiveService?) {
        self.mode = mode
        self.service = service
        installed = true
    }

    /// Test seam: back to the never-installed state, including the store hooks `install` set.
    func resetForTesting() {
        sweepTask?.cancel(); idleTask?.cancel()
        sweepTask = nil; idleTask = nil
        service = nil
        mode = .off
        installed = false
        currentUserBox.clear(); lastUser.clear()
        ChatSessionStore.ownership = nil
        ChatSessionStore.onUserDelete = nil
    }

    /// Test seam: set who is signed in without running a sweep.
    func setUserForTesting(_ id: String?) {
        if let id { currentUserBox.set(id); lastUser.set(id) } else { currentUserBox.clear() }
    }

    /// Extension chats waiting for the user to accept an incomplete archive.
    func chatsNeedingDecision() async -> [String: ChatArchiveOutcome] {
        guard let service else { return [:] }
        return await service.needsDecision
    }
}

private final class LockedString: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    func set(_ v: String) { lock.lock(); value = v; lock.unlock() }
    func clear() { lock.lock(); value = nil; lock.unlock() }
    func get() -> String? { lock.lock(); defer { lock.unlock() }; return value }
}

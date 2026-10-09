import Foundation

/// Process-wide FIFO queue for Loop runs that share one git working tree.
///
/// `LoopEngineRunner` admits at most one in-flight run per symlink-resolved
/// `gitRoot`. Callers that arrive while a run is active wait here instead of
/// being rejected — the same runner instance still refuses re-entrancy via its
/// own `running` flag.
@MainActor
enum LoopRunQueue {

    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Void, Error>
    }

    /// Roots with a run currently holding the lock (started, not merely queued).
    private static var heldRoots: Set<String> = [] {
        didSet { LoopRunQueueMirror.update(heldRoots) }
    }
    /// Per-root FIFO of waiters blocked on `acquire`.
    private static var waiters: [String: [Waiter]] = [:]

    /// True when a run has acquired the lock and is executing (or is between
    /// acquire and release).
    static func isActive(rootKey: String) -> Bool {
        heldRoots.contains(rootKey)
    }

    /// How many runs are waiting behind the in-flight one for `rootKey`.
    static func queuedCount(rootKey: String) -> Int {
        waiters[rootKey]?.count ?? 0
    }

    /// True when `acquire` would suspend rather than return immediately.
    static func willWait(rootKey: String) -> Bool {
        heldRoots.contains(rootKey)
    }

    /// Wait until this caller may run on `rootKey`, then take the lock.
    ///
    /// - Throws: `CancellationError` when the waiting task is cancelled —
    ///   the caller is removed from the queue and does not acquire the lock.
    static func acquire(rootKey: String) async throws {
        try Task.checkCancellation()
        if !heldRoots.contains(rootKey) {
            heldRoots.insert(rootKey)
            return
        }

        let waiterId = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                waiters[rootKey, default: []].append(Waiter(id: waiterId, continuation: cont))
            }
        } onCancel: {
            Task { @MainActor in
                cancelWaiter(rootKey: rootKey, id: waiterId)
            }
        }
        // Cancellation can land after `release` already handed this waiter the
        // lock (the cancel hop finds no waiter to remove). Give the lock back
        // instead of running a cancelled caller that holds it.
        if Task.isCancelled {
            release(rootKey: rootKey)
            throw CancellationError()
        }
    }

    /// Release the lock after a run finishes. Wakes the next queued caller, which
    /// inherits the lock without re-entering the empty-root branch of `acquire`.
    static func release(rootKey: String) {
        guard heldRoots.contains(rootKey) else { return }
        if var list = waiters[rootKey], !list.isEmpty {
            let next = list.removeFirst()
            waiters[rootKey] = list.isEmpty ? nil : list
            next.continuation.resume()
        } else {
            heldRoots.remove(rootKey)
        }
    }

    private static func cancelWaiter(rootKey: String, id: UUID) {
        guard var list = waiters[rootKey],
              let idx = list.firstIndex(where: { $0.id == id }) else { return }
        let waiter = list.remove(at: idx)
        waiters[rootKey] = list.isEmpty ? nil : list
        waiter.continuation.resume(throwing: CancellationError())
    }

#if DEBUG
    /// Resets queue state between tests. Not for production use.
    static func _resetForTesting() {
        heldRoots.removeAll()
        for list in waiters.values {
            for waiter in list {
                waiter.continuation.resume(throwing: CancellationError())
            }
        }
        waiters.removeAll()
    }
#endif
}


/// A lock-guarded copy of `LoopRunQueue`'s held roots that can be read from ANY
/// thread. The queue itself is main-actor isolated, but its answer is needed by
/// the (nonisolated, sometimes background) config store, which must not rewrite
/// `system/loop.json` while a run is active — the repair guard would read that
/// rewrite as the agent's edit.
enum LoopRunQueueMirror {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var held: Set<String> = []

    fileprivate static func update(_ roots: Set<String>) {
        lock.lock(); defer { lock.unlock() }
        held = roots
    }

    /// Whether a run currently holds a root that contains `url`.
    nonisolated static func isActive(containing url: URL) -> Bool {
        let path = url.resolvingSymlinksInPath().path
        lock.lock(); defer { lock.unlock() }
        return held.contains { path == $0 || path.hasPrefix($0 + "/") }
    }

    /// Whether a run currently holds `gitRoot` (same keying as `LoopRunQueue`).
    nonisolated static func isActive(gitRoot: URL) -> Bool {
        let key = gitRoot.resolvingSymlinksInPath().path
        lock.lock(); defer { lock.unlock() }
        return held.contains(key)
    }
}

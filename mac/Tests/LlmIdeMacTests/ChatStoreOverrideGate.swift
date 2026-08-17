import Foundation

/// Cross-suite mutual exclusion for tests that point the process-global
/// `ChatSessionStore.baseDirectoryOverride` at a throwaway directory.
///
/// swift-testing runs suites in parallel by default, and `@Suite(.serialized)`
/// only orders tests WITHIN one suite — so two override-driving suites
/// (`ChatEngineSessionTests` plus the two suites in `ChatEngineRegistryTests`)
/// interleave at every `await`: suite A saves a session under its tmp
/// directory, suite B flips the static to its own directory, and A's very
/// next `ChatSessionStore.load(id:)` looks in the wrong place and returns
/// nil. That failed the full `swift test` run ("switchSession bumps epoch —
/// a scheduled auto-continue from the old session no-ops") repeatedly while
/// the same suite passed in isolation, in pairwise filters, and under
/// `--no-parallel` — no production bug anywhere, only test parallelism over
/// a shared static.
///
/// Grab it for the WHOLE body of a suite's `withTempStore` helper (see the
/// three call sites) so the override is only ever touched by one suite at a
/// time:
///
///     await ChatStoreOverrideGate.shared.acquire()
///     defer { ChatStoreOverrideGate.shared.release() }
///
/// A binary semaphore rather than an actor because actors are reentrant:
/// an `actor.test { … }` method suspends at its first `await` and lets a
/// second caller in, which is exactly the interleaving this gate exists to
/// prevent. `@unchecked Sendable` — all state is guarded by `lock`.
final class ChatStoreOverrideGate: @unchecked Sendable {
    static let shared = ChatStoreOverrideGate()

    private let lock = NSLock()
    private var held = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private init() {}

    /// Suspend until the gate is free, then hold it. Paired with `release()`
    /// via `defer` so a throwing body can't strand the gate held.
    func acquire() async {
        lock.lock()
        if !held {
            held = true
            lock.unlock()
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
            lock.unlock()
        }
    }

    /// Hand the gate to the longest-waiting acquirer, if any.
    func release() {
        lock.lock()
        if let next = waiters.first {
            waiters.removeFirst()
            lock.unlock()
            next.resume()
            return
        }
        held = false
        lock.unlock()
    }
}

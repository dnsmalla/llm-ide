import Foundation
import os.log

/// Work that must run in `applicationWillTerminate` but belongs to a layer
/// `AppDelegate` (Core) may not name — today, flushing Chat's debounced
/// session writes. Shell registers each hook at boot; the delegate runs them.
///
/// A registry rather than a direct call because Core is a leaf: it must never
/// reference a `Features/` type, and Chat is build-excludable in principle.
///
/// Two kinds, because `applicationWillTerminate` returns straight into process
/// exit and an async hook would never finish there:
/// - `register`: synchronous, runs in `applicationWillTerminate`, registration order.
/// - `registerAsync`: runs BEFORE that, while the app is held open by
///   `applicationShouldTerminate` returning `.terminateLater`, under a hard time
///   cap (`hardCapSeconds`). The spawned backend is still up for the whole of it,
///   because `BackendManager` only kills the child at `willTerminate`, which AppKit
///   posts after the app replies to the terminate request. Nothing is registered
///   by default: with no async hook the quit is the synchronous one it always was.
@MainActor
enum AppTerminationHooks {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "AppDelegate")
    private static var hooks: [(label: String, run: @MainActor () -> Void)] = []
    private static var asyncHooks: [AsyncHook] = []

    /// The longest the whole async phase may hold a quit open. The caller replies
    /// to AppKit when it ends, finished or not: work that did not finish is picked
    /// up by the next start (every async hook must be safe to cut).
    nonisolated static let hardCapSeconds: TimeInterval = 6

    struct AsyncHook {
        let label: String
        /// This hook's own budget, further bounded by what is left of the cap.
        let timeout: TimeInterval
        let run: @MainActor () async throws -> Void
    }

    enum Outcome: Equatable {
        case completed
        case timedOut
        case failed(String)
    }

    struct Report: Equatable {
        /// One entry per hook that STARTED, in order.
        var results: [(label: String, outcome: Outcome)] = []
        /// The cap ended the phase: hooks after the last entry never started.
        var capReached = false
        var notStarted: [String] = []

        static func == (a: Report, b: Report) -> Bool {
            a.capReached == b.capReached && a.notStarted == b.notStarted
                && a.results.map(\.label) == b.results.map(\.label)
                && a.results.map(\.outcome) == b.results.map(\.outcome)
        }
    }

    /// Add `hook` to the quit-time list. `label` is for the log only.
    /// Precondition: called on the main actor, normally once per hook at boot.
    /// Registering the same label twice runs it twice — callers register once.
    static func register(_ label: String, _ hook: @escaping @MainActor () -> Void) {
        hooks.append((label, hook))
    }

    /// Add an async hook run under `.terminateLater` (see the type comment).
    /// `timeout` is this hook's own budget; the whole phase is capped at
    /// `hardCapSeconds` regardless. A hook that throws or times out is logged and
    /// the next one still runs.
    static func registerAsync(_ label: String, timeout: TimeInterval = hardCapSeconds,
                              _ hook: @escaping @MainActor () async throws -> Void) {
        asyncHooks.append(AsyncHook(label: label, timeout: timeout, run: hook))
    }

    /// True when at least one async hook is registered.
    static var hasAsyncHooks: Bool { !asyncHooks.isEmpty }

    /// Run every registered hook in registration order. Called by
    /// `AppDelegate.applicationWillTerminate`; nothing else should call it.
    static func runAll() {
        for hook in hooks {
            log.debug("termination hook: \(hook.label, privacy: .public)")
            hook.run()
        }
    }

    /// Run the registered async hooks under the cap. Called by `AppDelegate` once per quit.
    static func runAsyncHooks(cap: TimeInterval = hardCapSeconds) async -> Report {
        await runAsync(asyncHooks, cap: cap)
    }

    /// Run `hooks` in order. Each gets `min(its timeout, what is left of cap)`. A hook that
    /// does not answer in time is ABANDONED (its task keeps running until the process
    /// exits; the phase moves on). Pure of the registry so tests pass fake hooks.
    static func runAsync(_ hooks: [AsyncHook], cap: TimeInterval) async -> Report {
        var report = Report()
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(cap))
        for (index, hook) in hooks.enumerated() {
            let left = clock.now.duration(to: deadline)
            if left <= .zero {
                report.capReached = true
                report.notStarted = hooks[index...].map(\.label)
                break
            }
            let budget = min(Duration.seconds(hook.timeout), left)
            let outcome = await race(hook, budget: budget)
            log.info("async termination hook \(hook.label, privacy: .public): \(String(describing: outcome), privacy: .public)")
            report.results.append((hook.label, outcome))
            if outcome == .timedOut, clock.now >= deadline {
                report.capReached = true
                report.notStarted = hooks[(index + 1)...].map(\.label)
                break
            }
        }
        return report
    }

    /// The hook against a timer; the first to finish decides. The loser is not awaited
    /// (an unresponsive network call must not extend the quit).
    private static func race(_ hook: AsyncHook, budget: Duration) async -> Outcome {
        let gate = OneShot<Outcome>()
        let work = Task { @MainActor in
            do {
                try await hook.run()
                gate.finish(.completed)
            } catch {
                gate.finish(.failed(String(describing: error)))
            }
        }
        let timer = Task {
            try? await Task.sleep(for: budget)
            gate.finish(.timedOut)
        }
        let outcome = await gate.wait()
        timer.cancel()
        if outcome == .timedOut { work.cancel() }
        return outcome
    }

    /// Test seam: drop every registration.
    static func resetForTesting() {
        hooks.removeAll()
        asyncHooks.removeAll()
    }
}

/// What `applicationShouldTerminate` must do. A pure function so the ordering
/// rules (the unsaved-drafts dialog FIRST, async hooks only for a quit that was
/// confirmed, one run per quit) are testable without an NSApplication.
enum AppTerminationDecision: Equatable {
    case cancel
    case now
    /// Hold the quit open and run the async hooks. `start: false` means a run is
    /// already in flight (a second quit request): keep waiting, do not start another.
    case later(start: Bool)

    static func decide(confirmDrafts: () -> Bool, hasAsyncHooks: Bool, inFlight: Bool) -> AppTerminationDecision {
        if inFlight { return .later(start: false) }
        guard confirmDrafts() else { return .cancel }
        return hasAsyncHooks ? .later(start: true) : .now
    }
}

/// A single-assignment box a task can wait on; `finish` after the first is ignored.
/// Resume and wait may happen in either order.
private final class OneShot<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T?
    private var continuation: CheckedContinuation<T, Never>?

    func finish(_ v: T) {
        lock.lock()
        if value != nil { lock.unlock(); return }
        value = v
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume(returning: v)
    }

    func wait() async -> T {
        await withCheckedContinuation { (c: CheckedContinuation<T, Never>) in
            lock.lock()
            if let v = value {
                lock.unlock()
                c.resume(returning: v)
            } else {
                continuation = c
                lock.unlock()
            }
        }
    }
}

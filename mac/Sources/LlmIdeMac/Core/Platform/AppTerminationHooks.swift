import Foundation
import os.log

/// Work that must run in `applicationWillTerminate` but belongs to a layer
/// `AppDelegate` (Core) may not name — today, flushing Chat's debounced
/// session writes. Shell registers each hook at boot; the delegate runs them.
///
/// A registry rather than a direct call because Core is a leaf: it must never
/// reference a `Features/` type, and Chat is build-excludable in principle.
/// Hooks run in registration order, on the main actor, synchronously — the
/// process exits right after `applicationWillTerminate` returns, so an async
/// hook would never finish.
@MainActor
enum AppTerminationHooks {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "AppDelegate")
    private static var hooks: [(label: String, run: @MainActor () -> Void)] = []

    /// Add `hook` to the quit-time list. `label` is for the log only.
    /// Precondition: called on the main actor, normally once per hook at boot.
    /// Registering the same label twice runs it twice — callers register once.
    static func register(_ label: String, _ hook: @escaping @MainActor () -> Void) {
        hooks.append((label, hook))
    }

    /// Run every registered hook in registration order. Called by
    /// `AppDelegate.applicationWillTerminate`; nothing else should call it.
    static func runAll() {
        for hook in hooks {
            log.debug("termination hook: \(hook.label, privacy: .public)")
            hook.run()
        }
    }
}

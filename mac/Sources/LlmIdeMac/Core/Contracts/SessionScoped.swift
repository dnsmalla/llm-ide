import Foundation

/// A long-lived object holding per-account state (feeds, run logs, cursors)
/// that must not survive a sign-out or account switch.
///
/// Contract:
/// - Precondition: called on the main actor, only on a definitive sign-out
///   (`SessionStore.clear()`), never on a transient token-refresh failure.
/// - Postcondition: no state derived from the previous account remains
///   observable, and in-flight work for it is cancelled or its results are
///   discarded. The object stays usable for the next sign-in.
@MainActor
protocol SessionScoped: AnyObject {
    func resetForSignOut()
}

extension Notification.Name {
    /// Posted on the main thread when credentials tied to the previous account
    /// must stop working: a DIFFERENT user signed in, or the user chose
    /// "Sign out and disconnect all accounts". A plain sign-out does not post
    /// it, so the same user signing back in keeps what they set up.
    ///
    /// A notification rather than a `SessionScoped` method so Core never names
    /// a build-excludable feature (Mobile Control observes it).
    static let accountCredentialsRevoked = Notification.Name("llmide.accountCredentialsRevoked")
}

/// Weak registry of `SessionScoped` objects, drained by `SessionStore.clear()`.
///
/// Features register themselves (or the Shell registers them) so Core never
/// has to name a build-excludable feature type.
@MainActor
final class SessionScopedRegistry {
    // NOTE: a shared instance mirrors `GenerationRegistry.shared`; the object
    // graph is built in several composition points that have no common owner.
    static let shared = SessionScopedRegistry()

    private struct WeakBox {
        weak var value: (any SessionScoped)?
    }
    private var boxes: [WeakBox] = []

    init() {}

    /// Registers `object` once; duplicates and deallocated entries are ignored.
    func register(_ object: any SessionScoped) {
        boxes.removeAll { $0.value == nil }
        guard !boxes.contains(where: { $0.value === object }) else { return }
        boxes.append(WeakBox(value: object))
    }

    /// Calls `resetForSignOut()` on every live conformer.
    func resetAll() {
        boxes.removeAll { $0.value == nil }
        for box in boxes {
            box.value?.resetForSignOut()
        }
    }

    var registeredCount: Int {
        boxes.filter { $0.value != nil }.count
    }
}

import Foundation

/// Whether a reveal request may be handed to Monaco right now.
///
/// One rule, learned from a real failure: a reveal fired against an EMPTY
/// buffer scrolls nothing, and `MonacoHost.Coordinator.applyPendingChanges`
/// records the request's `id` anyway (`MonacoHost.swift`'s
/// `lastRevealRequestId` is written whether or not the editor had anything to
/// scroll) — so the request is spent and can never fire again. Callers must
/// therefore hold a target back until content has loaded, then apply it.
///
/// Pure and separated for tests, mirroring `WorkspaceRoot.pickGitRoot` and
/// `MonacoEditorMessageHandler.effect(for:)`. Lives in `Views/Shared/` rather
/// than `Views/Search/` because `Package.swift` excludes `Views/Search`
/// wholesale from the lite/min builds while never excluding its tests.
enum MonacoRevealGate {
    static func shouldApply(target: MonacoRevealRequest?, contentIsEmpty: Bool) -> Bool {
        guard target != nil else { return false }
        return !contentIsEmpty
    }
}

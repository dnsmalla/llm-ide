import Foundation

/// Core seam: a compiled-in feature registers a bridge that serves its
/// slice of the mobile protocol. When a feature is compiled out the slot
/// stays nil and the manager answers with a "not installed" ack instead.
///
/// `MobileControlManager` (Services/, always linked) holds only this
/// protocol type — never a concrete `MobileAutoTaskBridge`/`MobileLoopBridge`
/// — so the AutoTask/ and LoopEngine/ folders that own those concrete types
/// can later be excluded from the build without touching this file.
@MainActor
protocol MobileFeatureBridge: AnyObject {
    /// Handle one inbound message. Return false when the type is not ours
    /// (the manager then falls through to its normal unknown-type path).
    func handle(type: String, data: Data?) -> Bool
    /// Install Combine push observers (called once from the manager's
    /// installMobilePushObservers).
    func installPushObservers()
    /// Tear down whatever `installPushObservers()` subscribed — the teardown
    /// symmetry `installPushObservers()` was missing. Called once from the
    /// manager's `stop()`, right after it clears its own
    /// `mobilePushCancellables`, so a stopped server leaves no bridge holding
    /// live Combine subscriptions across a later `start()`. A no-op for a
    /// bridge that installs no subscriptions of its own.
    func removePushObservers()
}

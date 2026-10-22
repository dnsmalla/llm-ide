import Foundation
import os

/// Cache side effects that Core must trigger but only a build-excludable
/// feature can perform: dropping the Code Graph engine cache after a plugin
/// install/uninstall (`LlmIdeAPIClient`), and warming / clearing Mobile
/// Control's pairing-PIN cache alongside the keychain session cache
/// (`KeychainStore`).
///
/// A hook seam rather than a direct `FeatureCatalog` call because Core is a
/// leaf and may not name Shell (and `FeatureCatalog` itself only forwards to
/// feature code under `#if`). Shell installs the real forwarders once, in
/// `LlmIdeMacApp.init`, BEFORE `KeychainStore.warmSessionCache` — the earliest
/// read of any hook — so ordering is guaranteed by that one call site.
///
/// Every default is a no-op, which is exactly what `FeatureCatalog` did when
/// the owning feature is compiled out. So anything that runs without Shell's
/// boot (unit tests, the contract labs) behaves like a build without that
/// feature instead of crashing — the only cost of a missed install is a
/// skipped cache warm/clear, never a wrong secret.
enum FeatureCacheHooks {
    /// Drop the cached graph-engine resolution. Main-actor because the
    /// `FeatureCatalog` seam it forwards to is, and the API client already
    /// hops to the main actor to call it — kept as it was before the seam.
    @MainActor static var invalidateGraphEngineCache: @MainActor () -> Void = {}

    /// Load the Mobile Control pairing PIN into its session cache. Called
    /// synchronously from `KeychainStore.warmSessionCache`, which is not
    /// main-actor isolated — hence lock-guarded storage, not a `@MainActor` var.
    static var warmMobilePinCache: @Sendable () -> Void {
        get { mobilePinHooks.withLock { $0.warm } }
        set { mobilePinHooks.withLock { $0.warm = newValue } }
    }

    /// Drop the Mobile Control pairing PIN from its session cache after a
    /// keychain wipe (logout). Same isolation story as `warmMobilePinCache`.
    static var clearMobilePinSessionCache: @Sendable () -> Void {
        get { mobilePinHooks.withLock { $0.clear } }
        set { mobilePinHooks.withLock { $0.clear = newValue } }
    }

    private struct MobilePinHooks {
        var warm: @Sendable () -> Void = {}
        var clear: @Sendable () -> Void = {}
    }

    // The closure is read under the lock and CALLED after it is released (the
    // getters return it), so a hook that itself touches these hooks cannot
    // deadlock on the unfair lock.
    private static let mobilePinHooks = OSAllocatedUnfairLock(initialState: MobilePinHooks())
}

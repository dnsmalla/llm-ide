import Foundation

/// C5 device lifetime policy, shared by the sync and Host API clients. The numbers and the boundary rows are
/// pinned by `schema/sync/v1/vectors/v1.json` `devicePolicy`, which Node and Swift both execute.
///
/// - A sync manifest is readable through `validUntil` plus a 7-day grace, then `stale_manifest`: the desktop may
///   have been off long enough for its keys to rotate, so the old snapshot must not be trusted.
/// - A Host API device token lives at most 90 days from PAIRING, even while active; exactly 90 days is still valid,
///   anything past it re-pairs.
public enum SyncPolicy {
    public static let dayMs = 86_400_000
    public static let staleManifestAfterMs = 7 * dayMs
    public static let deviceTokenMaxLifetimeMs = 90 * dayMs

    public enum ManifestState: String, Equatable, Sendable {
        case fresh
        case withheld
        case staleManifest = "stale_manifest"
    }

    public static func manifestState(validUntil: Int, nowMs: Int) -> ManifestState {
        if validUntil + staleManifestAfterMs < nowMs { return .staleManifest }
        return nowMs > validUntil ? .withheld : .fresh
    }

    public enum DeviceTokenState: String, Equatable, Sendable {
        case live
        case expired
    }

    public static func deviceTokenState(pairedAt: Int, nowMs: Int) -> DeviceTokenState {
        nowMs - pairedAt > deviceTokenMaxLifetimeMs ? .expired : .live
    }
}

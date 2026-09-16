import Foundation
import Security
import os.log

/// Generates and stores the 6-digit mobile-pairing PIN in the macOS Keychain
/// under account `mobile::pin`, mirroring `KeychainStore`'s service identifier
/// (`com.llmide.macapp`) and accessibility policy
/// (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
///
/// `KeychainStore` only exposes host-scoped helpers (`saveToken(host:)`,
/// `saveGitLabToken(host:)`, …) publicly; its generic `save`/`load` primitives
/// and `service` constant are `private`. To keep this concern self-contained
/// without widening `KeychainStore`'s public surface, `MobilePin` issues its own
/// `SecItem` calls against the same service + accessibility policy that
/// `KeychainStore` uses. Replaces the old file-based `~/.aicontrol.json` PIN.
enum MobilePin {
    /// Keychain service identifier — kept in sync with `KeychainStore.service`.
    private static let service = "com.llmide.macapp"
    /// The account name under which the PIN is stored.
    static let account = "mobile::pin"
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "MobilePin")

    /// Cached for the app session so Settings refresh / scene-phase probes
    /// don't re-hit the Keychain (and re-prompt for the login password).
    private static var sessionPin: String?
    private static let cacheLock = NSLock()

    /// Load the PIN into the session cache. Called from `KeychainStore.warmSessionCache`.
    static func warmCache() {
        _ = read()
    }

    static func clearSessionCache() {
        cacheLock.lock()
        sessionPin = nil
        cacheLock.unlock()
    }

    /// Returns the stored PIN, generating and persisting a fresh one when none
    /// is stored yet.
    ///
    /// Throws rather than regenerating when the keychain is merely *unreadable*
    /// (denied / locked): a stored PIN is probably sitting there, and minting a
    /// replacement would overwrite it and invalidate every paired iPhone.
    static func ensure() throws -> String {
        switch load() {
        case .found(let pin): return pin
        case .notFound: return try regenerate()
        case .failed(let status): throw MobilePinError.keychainFailure(status)
        }
    }

    /// Reads the stored PIN, or nil when there is none *or* it can't be read.
    /// Callers that must tell those apart use `ensure()`.
    static func read() -> String? {
        if case .found(let pin) = load() { return pin }
        return nil
    }

    private enum PinRead {
        case found(String)
        case notFound
        case failed(OSStatus)
    }

    /// Reads through `KeychainStore.backend` so the pairing PIN shares the app's
    /// single raw-keychain path (and its test seam) instead of issuing its own
    /// `SecItem` calls.
    private static func load() -> PinRead {
        cacheLock.lock()
        if let cached = sessionPin {
            cacheLock.unlock()
            return .found(cached)
        }
        cacheLock.unlock()

        switch KeychainStore.backend.read(account: account, service: service) {
        case .found(let data):
            guard let pin = String(data: data, encoding: .utf8) else {
                return .failed(errSecDecode)
            }
            cacheLock.lock()
            sessionPin = pin
            cacheLock.unlock()
            return .found(pin)
        case .notFound:
            return .notFound
        case .failed(let status):
            log.error("MobilePin read failed: OSStatus \(status, privacy: .public)")
            return .failed(status)
        }
    }

    /// Generates a new random 6-digit PIN, overwrites any stored PIN, returns it.
    static func regenerate() throws -> String {
        let pin = mint()
        try write(pin)
        cacheLock.lock()
        sessionPin = pin
        cacheLock.unlock()
        return pin
    }

    /// Retire the current PIN NOW, without touching the Keychain: the new PIN
    /// goes into the session cache, which is what `read()` serves, so the very
    /// next validation sees it. Callers then `persist` the returned PIN off
    /// their own thread. Split from `regenerate()` because the pairing server
    /// rotates on its serial queue, and a `SecItem` write on a locked or
    /// prompting keychain parks the calling thread in securityd — which would
    /// freeze every frame, send and deadline that queue serialises.
    static func rotateInMemory() -> String {
        let pin = mint()
        cacheLock.lock()
        sessionPin = pin
        cacheLock.unlock()
        return pin
    }

    /// Write a PIN produced by `rotateInMemory()` to the Keychain. On failure
    /// the in-memory PIN stays live for this app session; the previous PIN
    /// would come back at next launch, which the caller should log loudly.
    static func persist(_ pin: String) throws {
        try write(pin)
    }

    /// SystemRandomNumberGenerator — sufficient entropy for a 6-digit LAN PIN
    /// behind `PairingThrottle`.
    private static func mint() -> String {
        var rng = SystemRandomNumberGenerator()
        return String(format: "%06d", Int.random(in: 0...999_999, using: &rng))
    }

    /// Stores `pin` under `mobile::pin`, overwriting any existing value.
    ///
    /// Goes through `KeychainStore.backend`, which updates in place and only
    /// adds when the account is absent, so a failed add can never empty it.
    private static func write(_ pin: String) throws {
        // pin is always a 6-digit ASCII string (`%06d`), so UTF-8 encoding
        // cannot fail — `Data(_:)` is infallible here.
        guard KeychainStore.backend.write(account: account,
                                          service: service,
                                          data: Data(pin.utf8)) else {
            log.error("MobilePin write failed")
            throw MobilePinError.keychainFailure(errSecIO)
        }
    }

    enum MobilePinError: Error {
        case keychainFailure(OSStatus)
    }
}

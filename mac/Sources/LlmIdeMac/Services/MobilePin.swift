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

    /// Returns the stored PIN, generating and persisting a fresh one on first call.
    static func ensure() throws -> String {
        if let existing = read() { return existing }
        return try regenerate()
    }

    /// Reads the stored PIN, or nil if none.
    static func read() -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Generates a new random 6-digit PIN, overwrites any stored PIN, returns it.
    static func regenerate() throws -> String {
        // SystemRandomNumberGenerator — sufficient entropy for a 6-digit LAN PIN.
        var rng = SystemRandomNumberGenerator()
        let n = Int.random(in: 0...999_999, using: &rng)
        let pin = String(format: "%06d", n)
        try write(pin)
        return pin
    }

    /// Stores `pin` under `mobile::pin`, overwriting any existing value.
    ///
    /// Update-then-add so a failed `SecItemAdd` can never empty the account
    /// (mirrors `KeychainStore.save`). New items are created with
    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` to match the rest of
    /// the app's keychain items.
    private static func write(_ pin: String) throws {
        guard let data = pin.data(using: .utf8) else {
            throw MobilePinError.encodingFailed
        }
        let match: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        let updateStatus = SecItemUpdate(match as CFDictionary,
                                         [kSecValueData: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            log.error("MobilePin SecItemUpdate failed: OSStatus \(updateStatus, privacy: .public)")
            throw MobilePinError.keychainFailure(updateStatus)
        }
        var addQuery = match
        addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        addQuery[kSecValueData] = data
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            log.error("MobilePin SecItemAdd failed: OSStatus \(addStatus, privacy: .public)")
            throw MobilePinError.keychainFailure(addStatus)
        }
    }

    enum MobilePinError: Error {
        case encodingFailed
        case keychainFailure(OSStatus)
    }
}

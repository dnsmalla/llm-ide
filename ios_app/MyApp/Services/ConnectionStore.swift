import Foundation
import Security

/// Persists the user's saved computer connection. IP and port live in
/// UserDefaults; the secrets — the PIN while pairing, then the per-device
/// token the Mac issues in exchange — live in the Keychain.
///
/// Credential lifecycle: the user enters (or scans) a PIN → `save(ip:port:pin:)`
/// → the first `Connected` frame carries a token → `saveToken` stores it and
/// drops the PIN, which the Mac has rotated anyway. From then on the phone
/// reconnects with the token alone. `clearCredentials` (revoked on the Mac,
/// or a non-retryable refusal) returns the phone to the pairing screen.
@MainActor
final class ConnectionStore: ObservableObject {
    private let defaults = UserDefaults.standard

    @Published var deviceIP: String
    @Published var devicePort: Int
    @Published var devicePIN: String
    /// Per-device token issued by the Mac at pairing time; empty until then.
    @Published private(set) var deviceToken: String
    /// Stable id this phone presents to every Mac it pairs with. Minted once,
    /// kept in UserDefaults (it is an identifier, not a secret).
    let deviceId: String
    /// Friendly Mac name from the server's `Connected` frame (e.g. "Dinesh's MacBook").
    @Published private(set) var deviceName: String = ""

    /// Either credential lets the phone connect: a token after pairing, or a
    /// PIN the user just entered and has not yet exchanged.
    var hasDevice: Bool { !deviceIP.isEmpty && (!deviceToken.isEmpty || !devicePIN.isEmpty) }

    /// Title for the paired home screen — prefers the Mac name over raw IP.
    var displayName: String { deviceName.isEmpty ? deviceIP : deviceName }

    init() {
        deviceIP   = defaults.string(forKey: "agent_ip")  ?? ""
        let saved  = defaults.integer(forKey: "agent_port")
        devicePort = saved > 0 ? saved : 3006
        deviceName = defaults.string(forKey: "agent_device_name") ?? ""
        if let existing = defaults.string(forKey: "agent_device_id"), !existing.isEmpty {
            deviceId = existing
        } else {
            let minted = UUID().uuidString
            defaults.set(minted, forKey: "agent_device_id")
            deviceId = minted
        }

        // Migrate a PIN stored by older versions in UserDefaults (plaintext).
        if let legacy = defaults.string(forKey: "agent_pin"), !legacy.isEmpty {
            // Drop the plaintext copy ONLY on a confirmed keychain write: the
            // unconditional remove meant a failed add wiped the sole copy and
            // the user silently had to re-pair.
            if CredentialKeychain.save(legacy, account: .pin) {
                defaults.removeObject(forKey: "agent_pin")
            }
        }
        devicePIN   = CredentialKeychain.load(account: .pin) ?? ""
        deviceToken = CredentialKeychain.load(account: .token) ?? ""
    }

    /// A fresh PIN means a fresh pairing: any token from a previous pairing is
    /// for a registry entry that is about to be replaced, so drop it, or the
    /// connect path would keep presenting a token the Mac may have revoked.
    func save(ip: String, port: Int, pin: String) {
        deviceIP   = ip
        devicePort = port
        devicePIN  = pin
        defaults.set(ip,   forKey: "agent_ip")
        defaults.set(port, forKey: "agent_port")
        CredentialKeychain.save(pin, account: .pin)
        if !pin.isEmpty { clearToken() }
    }

    /// The Mac accepted the PIN and issued a token. Keep the token, drop the
    /// PIN: the Mac rotates it right after this exchange, so the stored copy
    /// would only ever be re-sent as a wrong PIN. Returns false when the
    /// Keychain refused the token — the caller must say so, because the phone
    /// is then connected now but holds no credential for the next reconnect.
    @discardableResult
    func saveToken(_ token: String) -> Bool {
        guard !token.isEmpty, CredentialKeychain.save(token, account: .token) else { return false }
        deviceToken = token
        devicePIN = ""
        CredentialKeychain.delete(account: .pin)
        return true
    }

    private func clearToken() {
        deviceToken = ""
        CredentialKeychain.delete(account: .token)
    }

    /// Both secrets gone; IP/port/name stay so the Mac is still recognized on
    /// the pairing screen. Used when the Mac revokes this device or refuses
    /// its credentials outright.
    func clearCredentials() {
        clearSavedPIN()
        clearToken()
    }

    /// Clear only the saved PIN — keep IP/port/name so the Mac is still
    /// recognized. Called when the server rejects the PIN (`auth_failed`):
    /// without this, a stale PIN persisted across a Mac PIN change (reinstall,
    /// Keychain reset, update) is re-sent on every auto-connect and manual
    /// pre-fill, trapping the user in a "Wrong PIN" loop they can't escape
    /// (`ContentView` keeps routing to `MobileHomeView` because `hasDevice`
    /// stays true). Clearing the PIN flips `hasDevice` to false so the user
    /// lands on `ConnectView` and re-enters the current PIN.
    func clearSavedPIN() {
        devicePIN = ""
        CredentialKeychain.delete(account: .pin)
    }

    func updateDeviceName(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        deviceName = trimmed
        defaults.set(trimmed, forKey: "agent_device_name")
    }

    func clear() {
        deviceIP    = ""
        devicePIN   = ""
        deviceToken = ""
        devicePort  = 3006
        deviceName  = ""
        defaults.removeObject(forKey: "agent_ip")
        defaults.removeObject(forKey: "agent_port")
        defaults.removeObject(forKey: "agent_device_name")
        CredentialKeychain.delete(account: .pin)
        CredentialKeychain.delete(account: .token)
    }
}

// MARK: — Keychain wrapper for the pairing secrets

private enum CredentialKeychain {
    /// One Keychain item per secret. `.pin` keeps the account name older
    /// builds used ("saved-mac") so an existing PIN is still found after the
    /// update; `.token` is new.
    enum Account: String {
        case pin = "saved-mac"
        case token = "device-token"
    }

    private static func baseQuery(_ account: Account) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.llmide.device-pin",
         kSecAttrAccount as String: account.rawValue]
    }

    /// Returns true when the secret is stored. `ThisDeviceOnly` is the
    /// load-bearing half (`AfterFirstUnlock` matches the Mac's own policy and
    /// avoids failing to read while the device is locked): without it the
    /// pairing secret is included in encrypted device backups and RESTORES
    /// onto a different phone. A pairing secret must never leave the handset —
    /// the Mac side already uses the ThisDeviceOnly policy (`MobilePin`), so
    /// this closes the asymmetry. Doubly so for the token, which is the
    /// long-lived credential now.
    @discardableResult
    static func save(_ secret: String, account: Account) -> Bool {
        delete(account: account)
        guard !secret.isEmpty else { return false }
        var query = baseQuery(account)
        query[kSecValueData as String] = Data(secret.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func load(account: Account) -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: Account) {
        SecItemDelete(baseQuery(account) as CFDictionary)
    }
}

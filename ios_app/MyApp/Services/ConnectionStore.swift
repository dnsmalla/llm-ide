import Foundation
import Security

/// Persists the user's saved computer connection. IP and port live in
/// UserDefaults; the PIN is a secret and lives in the Keychain.
@MainActor
final class ConnectionStore: ObservableObject {
    private let defaults = UserDefaults.standard

    @Published var deviceIP: String
    @Published var devicePort: Int
    @Published var devicePIN: String
    /// Friendly Mac name from the server's `Connected` frame (e.g. "Dinesh's MacBook").
    @Published private(set) var deviceName: String = ""

    var hasDevice: Bool { !deviceIP.isEmpty && !devicePIN.isEmpty }

    /// Title for the paired home screen — prefers the Mac name over raw IP.
    var displayName: String { deviceName.isEmpty ? deviceIP : deviceName }

    init() {
        deviceIP   = defaults.string(forKey: "agent_ip")  ?? ""
        let saved  = defaults.integer(forKey: "agent_port")
        devicePort = saved > 0 ? saved : 3006
        deviceName = defaults.string(forKey: "agent_device_name") ?? ""

        // Migrate a PIN stored by older versions in UserDefaults (plaintext).
        if let legacy = defaults.string(forKey: "agent_pin"), !legacy.isEmpty {
            PinKeychain.save(legacy)
            defaults.removeObject(forKey: "agent_pin")
        }
        devicePIN = PinKeychain.load() ?? ""
    }

    func save(ip: String, port: Int, pin: String) {
        deviceIP   = ip
        devicePort = port
        devicePIN  = pin
        defaults.set(ip,   forKey: "agent_ip")
        defaults.set(port, forKey: "agent_port")
        PinKeychain.save(pin)
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
        PinKeychain.delete()
    }

    func updateDeviceName(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        deviceName = trimmed
        defaults.set(trimmed, forKey: "agent_device_name")
    }

    func clear() {
        deviceIP   = ""
        devicePIN  = ""
        devicePort = 3006
        deviceName = ""
        defaults.removeObject(forKey: "agent_ip")
        defaults.removeObject(forKey: "agent_port")
        defaults.removeObject(forKey: "agent_device_name")
        PinKeychain.delete()
    }
}

// MARK: — Keychain wrapper for the device PIN

private enum PinKeychain {
    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.llmide.device-pin",
         kSecAttrAccount as String: "saved-mac"]
    }

    static func save(_ pin: String) {
        delete()
        guard !pin.isEmpty else { return }
        var query = baseQuery
        query[kSecValueData as String] = Data(pin.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(query as CFDictionary, nil)
    }

    static func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

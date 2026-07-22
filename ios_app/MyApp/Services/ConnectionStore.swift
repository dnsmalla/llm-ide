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

    var hasDevice: Bool { !deviceIP.isEmpty && !devicePIN.isEmpty }

    init() {
        deviceIP   = defaults.string(forKey: "agent_ip")  ?? ""
        let saved  = defaults.integer(forKey: "agent_port")
        devicePort = saved > 0 ? saved : 3006

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

    func clear() {
        deviceIP   = ""
        devicePIN  = ""
        devicePort = 3006
        defaults.removeObject(forKey: "agent_ip")
        defaults.removeObject(forKey: "agent_port")
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

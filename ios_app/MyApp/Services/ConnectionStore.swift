import Foundation
import Security
import SharedProtocol

/// Persists the paired desktop. The address, v1 port and host name live in UserDefaults; the secrets —
/// the PIN while pairing, then the device token the host issues for it, and the host's certificate pin —
/// live in the Keychain.
///
/// Credential lifecycle: the user scans the desktop's pairing QR → `save(ip:pin:hostApiOffer:source:)`
/// stores the address, PIN and certificate pin → `host.auth.pair` returns a token → `saveHostApiToken`
/// stores it and drops the PIN, which the host rotated. From then on the phone reconnects with the token
/// alone. `clearCredentials` (removed on the host) returns the phone to the pairing screen.
@MainActor
final class ConnectionStore: ObservableObject {
    private let defaults = UserDefaults.standard

    @Published var deviceIP: String
    @Published var devicePIN: String
    /// Host API v1 device token (spec "Security": in Keychain on iOS). Empty until paired.
    @Published private(set) var hostApiToken: String
    /// The host's certificate fingerprint learned from the pairing QR, Keychain-held next to the token, and
    /// its TLS port (UserDefaults). Empty/0 until a QR pairing.
    private(set) var hostApiPin: String
    private(set) var hostApiPort: Int
    /// Friendly host name from `host.hello` (e.g. "Dinesh's MacBook").
    @Published private(set) var deviceName: String = ""

    /// Either credential lets the phone connect: a token after pairing, or a
    /// PIN the user just entered and has not yet exchanged.
    var hasDevice: Bool { !deviceIP.isEmpty && (!hostApiToken.isEmpty || !devicePIN.isEmpty) }

    /// Title for the paired home screen — prefers the host name over raw IP.
    var displayName: String { deviceName.isEmpty ? deviceIP : deviceName }

    init() {
        deviceIP   = defaults.string(forKey: "agent_ip")  ?? ""
        deviceName = defaults.string(forKey: "agent_device_name") ?? ""
        // Leftovers of the retired MobileProtocol v2 Mac link: its port, device id and token.
        defaults.removeObject(forKey: "agent_port")
        defaults.removeObject(forKey: "agent_device_id")
        defaults.removeObject(forKey: "agent_pin")
        CredentialKeychain.delete(account: .legacyV2Token)
        devicePIN   = CredentialKeychain.load(account: .pin) ?? ""
        hostApiToken = CredentialKeychain.load(account: .hostApiToken) ?? ""
        hostApiPin = CredentialKeychain.load(account: .hostApiPin) ?? ""
        hostApiPort = defaults.integer(forKey: "agent_h1port")
    }

    /// A fresh PIN means a fresh pairing: any token from a previous pairing is
    /// for a registry entry that is about to be replaced, so drop it, or the
    /// connect path would keep presenting a token the host may have revoked.
    ///
    /// `hostApiOffer` is what the QR offered. Pinning is QR-only (`HostApiPinning.pinAfterOffer`): a typed
    /// PIN keeps the same host's pin and port.
    func save(ip: String, pin: String, hostApiOffer: HostApiPairingOffer? = nil, source: HostApiPairingSource) {
        let sameHost = ip == deviceIP
        deviceIP   = ip
        devicePIN  = pin
        defaults.set(ip, forKey: "agent_ip")
        CredentialKeychain.save(pin, account: .pin)
        guard !pin.isEmpty else { return }
        clearToken()
        let newPin = HostApiPinning.pinAfterOffer(stored: hostApiPin.isEmpty ? nil : hostApiPin,
                                                  offered: hostApiOffer?.fingerprint, source: source, sameHost: sameHost)
        if source != .qrScan, newPin != nil { return }
        // A pin the Keychain refused is dropped: v1 is then not dialled, never dialled unpinned.
        if let newPin, CredentialKeychain.save(newPin, account: .hostApiPin) { hostApiPin = newPin } else {
            hostApiPin = ""
            CredentialKeychain.delete(account: .hostApiPin)
        }
        hostApiPort = hostApiPin.isEmpty ? 0 : hostApiOffer?.port ?? 0
        defaults.set(hostApiPort, forKey: "agent_h1port")
    }

    /// The host accepted the PIN and issued a token. Keep the token, drop the PIN, which the host rotated.
    /// Returns false when the Keychain refused the token — the caller must say so, because the phone is
    /// then connected now but holds no credential for the next reconnect.
    @discardableResult
    func saveHostApiToken(_ token: String) -> Bool {
        guard !token.isEmpty, CredentialKeychain.save(token, account: .hostApiToken) else { return false }
        hostApiToken = token
        devicePIN = ""
        CredentialKeychain.delete(account: .pin)
        return true
    }

    /// Where to reach the host; nil until a QR pairing stored a pin. A pinned pairing dials
    /// `wss://<ip>:<h1port>/host-api/v1`. Development only: a DEBUG build lets `LLMIDE_HOST_API_URL` from the
    /// Xcode scheme (Run → Environment) override it, e.g. `ws://127.0.0.1:3016/host-api/v1` for the Simulator
    /// against a desktop host started with `LLMIDE_HOST_API_DEV=1`.
    var hostApiEndpoint: HostApiEndpoint? {
        #if DEBUG
        if let dev = ProcessInfo.processInfo.environment["LLMIDE_HOST_API_URL"].flatMap(HostApiEndpoint.init) { return dev }
        #endif
        guard !hostApiPin.isEmpty, !deviceIP.isEmpty, hostApiPort > 0 else { return nil }
        return HostApiPairingOffer(port: hostApiPort, fingerprint: hostApiPin).endpoint(host: deviceIP)
    }

    private func clearToken() {
        hostApiToken = ""
        CredentialKeychain.delete(account: .hostApiToken)
    }

    /// PIN and token gone; the address, pin and name stay so the host is still recognized. Used when the
    /// host removed this device.
    func clearCredentials() {
        devicePIN = ""
        CredentialKeychain.delete(account: .pin)
        clearToken()
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
        hostApiToken = ""
        hostApiPin = ""
        hostApiPort = 0
        deviceName  = ""
        defaults.removeObject(forKey: "agent_ip")
        defaults.removeObject(forKey: "agent_device_name")
        defaults.removeObject(forKey: "agent_h1port")
        CredentialKeychain.delete(account: .hostApiPin)
        CredentialKeychain.delete(account: .pin)
        CredentialKeychain.delete(account: .hostApiToken)
    }
}

// MARK: — Keychain wrapper for the pairing secrets

private enum CredentialKeychain {
    /// One Keychain item per secret. `.pin` keeps the account name older
    /// builds used ("saved-mac"). `.legacyV2Token` is only ever deleted.
    enum Account: String {
        case pin = "saved-mac"
        case legacyV2Token = "device-token"
        case hostApiToken = "host-api-token"
        case hostApiPin = "host-api-pin"
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
    /// doubly so for the token, which is the long-lived credential.
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

import Foundation
import CryptoKit

/// The iPhones that have completed PIN pairing, keyed by the device id each
/// phone chose for itself, and the per-device tokens they reconnect with.
///
/// Why tokens at all: the PIN used to be the long-lived credential — the phone
/// kept it and re-sent it on every reconnect — so the PIN could never rotate
/// without forcing a re-pair, and there was nothing to revoke short of
/// changing the PIN for everyone. Pairing now trades the PIN for a token once;
/// the PIN rotates immediately after; revoking a device deletes its record.
///
/// Only a SHA-256 of each token is kept, so the file on disk is worthless
/// without the phone's Keychain and can live in Application Support as plain
/// JSON. Thread-safe (`NSLock`): the WebSocket server consults it on its own
/// serial queue while Settings reads it on the main actor.
final class MobilePairedDeviceStore: @unchecked Sendable {
    struct Device: Codable, Equatable, Identifiable {
        let id: String
        var name: String
        let tokenHash: String
        let pairedAt: Date
        var lastSeenAt: Date
    }

    static let tokenByteCount = 32
    /// Anyone who holds the PIN can add a record, so the registry is bounded:
    /// past this many devices the least recently seen one is dropped.
    static let maxDevices = 20

    private let fileURL: URL
    private let lock = NSLock()
    private var devices: [Device]

    /// `~/Library/Application Support/llm-ide/mobile-paired-devices.json`,
    /// next to the chat sessions and crash reports.
    static func defaultFileURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("llm-ide", isDirectory: true)
            .appendingPathComponent("mobile-paired-devices.json")
    }

    init(fileURL: URL = MobilePairedDeviceStore.defaultFileURL()) {
        self.fileURL = fileURL
        self.devices = Self.load(from: fileURL)
    }

    /// Every paired device, most recently seen first.
    var all: [Device] {
        lock.lock(); defer { lock.unlock() }
        return devices.sorted { $0.lastSeenAt > $1.lastSeenAt }
    }

    /// Mint a fresh token for `deviceId` and remember only its hash. Pairing
    /// the same device id again replaces the previous record, so the old token
    /// stops working the moment the new one is issued. Returns the token to
    /// hand to the phone — the only time it exists in plain text on the Mac.
    func issueToken(deviceId: String, name: String, now: Date = Date()) -> String {
        let token = Self.randomToken()
        let record = Device(id: deviceId, name: Self.cleanName(name),
                            tokenHash: Self.hash(token), pairedAt: now, lastSeenAt: now)
        lock.lock(); defer { lock.unlock() }
        devices.removeAll { $0.id == deviceId }
        devices.append(record)
        while devices.count > Self.maxDevices,
              let oldest = devices.min(by: { $0.lastSeenAt < $1.lastSeenAt }) {
            devices.removeAll { $0.id == oldest.id }
        }
        persistLocked()
        return token
    }

    /// True iff `token` is the live token for `deviceId`. Compared in constant
    /// time on the hashes; a match also stamps `lastSeenAt`.
    func authenticate(deviceId: String, token: String, now: Date = Date()) -> Bool {
        guard !deviceId.isEmpty, !token.isEmpty else { return false }
        let candidate = Self.hash(token)
        lock.lock(); defer { lock.unlock() }
        guard let index = devices.firstIndex(where: { $0.id == deviceId }),
              Self.constantTimeEqual(devices[index].tokenHash, candidate) else {
            return false
        }
        devices[index].lastSeenAt = now
        persistLocked()
        return true
    }

    /// Forget a device. Its token is refused from the next frame on; the
    /// caller is responsible for dropping a live connection it may hold.
    func revoke(id: String) {
        lock.lock(); defer { lock.unlock() }
        let before = devices.count
        devices.removeAll { $0.id == id }
        if devices.count != before { persistLocked() }
    }

    func device(id: String) -> Device? {
        lock.lock(); defer { lock.unlock() }
        return devices.first { $0.id == id }
    }

    // MARK: - Tokens

    static func hash(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// 32 random bytes (SystemRandomNumberGenerator is the system CSPRNG),
    /// base64url without padding: URL- and JSON-safe, 43 characters.
    private static func randomToken() -> String {
        var rng = SystemRandomNumberGenerator()
        let bytes = (0..<tokenByteCount).map { _ in UInt8.random(in: .min ... .max, using: &rng) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Length-independent comparison so a wrong token costs the same time as
    /// a right one regardless of where they first differ.
    private static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        var diff = x.count ^ y.count
        for i in 0..<min(x.count, y.count) { diff |= Int(x[i] ^ y[i]) }
        return diff == 0
    }

    private static func cleanName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "iPhone" : String(trimmed.prefix(64))
    }

    // MARK: - Persistence

    private static func load(from url: URL) -> [Device] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([Device].self, from: data)) ?? []
    }

    /// Caller holds `lock`. Atomic write, owner-only permissions — the file
    /// holds hashes, not tokens, but there is no reason to widen it.
    private func persistLocked() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(devices) else { return }
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}

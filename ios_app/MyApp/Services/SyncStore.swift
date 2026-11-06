import Foundation
import CryptoKit
import Security
import UIKit
import SharedProtocol

/// The iPhone's sync tier: with the desktop off, read the last encrypted snapshot and queue chat prompts.
@MainActor
final class SyncStore: ObservableObject {
    enum Phase: Equatable { case off, needsPassword, ready, removed }
    enum EnrollStep: Equatable { case login, working(String), sas(String), done, failed(String) }
    struct Queued: Codable, Identifiable, Equatable {
        let id: String
        let text: String
        let issuedAtMs: Int
        var answer: String?
        var code: String?
        var isPending: Bool { answer == nil && code == nil }
    }
    private struct StoredKeys: Codable { var secureEnclave: Bool; var signing: Data; var ecdh: Data }
    private struct StoredMega: Codable { var email: String; var folder: String; var session: MegaClient.Session }

    @Published private(set) var phase: Phase = .off
    @Published private(set) var snapshot: SyncSnapshot?
    @Published private(set) var queued: [Queued] = []
    @Published private(set) var lastError: String?
    @Published private(set) var refreshing = false
    @Published private(set) var enrollStep: EnrollStep?
    @Published private(set) var megaEmail = ""

    private var device: SyncDevice?
    private var mega: MegaClient?
    private var pendingPair: SyncPair?
    /// The claim prepared for `pendingPair`, kept across retries so a retry rewrites the same claim (contract 4c).
    private var prepared: (device: SyncDevice, stored: StoredKeys)?
    /// The name in the prepared claim; a retry cannot change it.
    var preparedName: String? { prepared?.device.state.name }
    private var enrollTask: Task<Void, Never>?
    private var foregroundTask: Task<Void, Never>?
    private var nowMs: Int { Int(Date().timeIntervalSince1970 * 1000) }

    init() { restore() }

    private func restore() {
        guard let st = Keychain.load(SyncDeviceState.self, .state), st.isEnrolled,
              let sk = Keychain.load(StoredKeys.self, .keys), let keys = try? Self.loadKeys(sk),
              let d = try? SyncDevice(state: st, keys: keys) else { return }
        attach(d)
        queued = Self.read([Queued].self, "queue.json") ?? []
        if let m = Keychain.load(StoredMega.self, .mega) {
            megaEmail = m.email
            mega = MegaClient(folder: m.folder, session: m.session)
            phase = .ready
        } else { phase = .needsPassword }
        if let cache = Self.read([String: Data].self, "snapshot-cache.json"), !cache.isEmpty {
            Task { snapshot = (try? await d.readSnapshot(SyncDictionaryStore(files: cache), nowMs: nowMs)) ?? nil }
        }
    }

    private func attach(_ d: SyncDevice) {
        device = d
        d.onStateChange = { _ = Keychain.save($0, .state) }
    }

    private static func makeKeys() throws -> (SyncDeviceKeys, StoredKeys) {
        if SecureEnclaveSyncDeviceKeys.isAvailable {
            let k = try SecureEnclaveSyncDeviceKeys()
            return (k, StoredKeys(secureEnclave: true, signing: k.signingBlob, ecdh: k.ecdhBlob))
        }
        let k = SoftwareSyncDeviceKeys()
        return (k, StoredKeys(secureEnclave: false, signing: k.signing.rawRepresentation, ecdh: k.ecdh.rawRepresentation))
    }
    private static func loadKeys(_ s: StoredKeys) throws -> SyncDeviceKeys {
        if s.secureEnclave { return try SecureEnclaveSyncDeviceKeys(signingBlob: s.signing, ecdhBlob: s.ecdh) }
        return SoftwareSyncDeviceKeys(signing: try .init(rawRepresentation: s.signing), ecdh: try .init(rawRepresentation: s.ecdh))
    }

    func startEnrollment(_ pair: SyncPair) {
        guard pair.st.hasPrefix("mega:") else { lastError = "This code is not for a MEGA sync folder."; return }
        pendingPair = pair; prepared = nil
        Task { try? await Task.sleep(nanoseconds: 600_000_000); enrollStep = .login }
    }
    func enroll(email: String, password: String, name: String) {
        guard let pair = pendingPair else { return }
        enrollTask?.cancel()
        enrollTask = Task { await runEnrollment(pair: pair, email: email, password: password, name: name) }
    }
    func cancelEnrollment() {
        enrollTask?.cancel(); enrollTask = nil; enrollStep = nil; pendingPair = nil; prepared = nil
    }
    /// Back to the sign-in form for the same QR; the prepared claim is reused.
    func retryEnrollment() { if pendingPair != nil { enrollStep = .login } }

    private func runEnrollment(pair: SyncPair, email: String, password: String, name: String) async {
        let folder = String(pair.st.dropFirst("mega:".count))
        var client: MegaClient?
        do {
            enrollStep = .working("Signing in to MEGA…")
            let session = try await MegaClient.login(email: email, password: password)
            let c = MegaClient(folder: folder, session: session)
            client = c
            enrollStep = .working("Checking the desktop's key…")
            let (d, stored): (SyncDevice, StoredKeys)
            if let p = prepared { (d, stored) = p } else {
                let (keys, s) = try Self.makeKeys()
                let nd = try await SyncDevice.prepare(pair: pair, name: name, keys: keys, store: c, nowMs: nowMs)
                (d, stored) = (nd, s)
                prepared = (nd, s)
            }
            if d.state.userId == nil {  // not acked yet: (re)write the same claim; after the ack the slot may be gone
                _ = try await poll(SyncDevice.ackWindowMs) { try await d.writeClaim(c); return true }
            }
            enrollStep = .working("Waiting for the desktop…")
            // A retry after the ack: the slot is gone once the desktop confirmed, so go straight to the wrap.
            let sas: String?
            if d.state.userId != nil { sas = try await d.readAck(c) }
            else { sas = try await poll(SyncDevice.ackWindowMs) { try await d.readAck(c) } }
            if let sas {
                enrollStep = .sas(sas)
                UIAccessibility.post(notification: .announcement, argument: "Code ready. Compare it with the desktop.")
            }
            _ = try await poll(SyncDevice.wrapWindowMs) { try await d.readWrap(c, nowMs: self.nowMs) ? true : nil }
            prepared = nil; pendingPair = nil
            await mega?.logout()
            _ = Keychain.save(stored, .keys)
            _ = Keychain.save(d.state, .state)
            _ = Keychain.save(StoredMega(email: email, folder: folder, session: session), .mega)
            attach(d); mega = c; megaEmail = email
            queued = []; Self.write(queued, "queue.json")
            phase = .ready; enrollStep = .done
            await refresh()
        } catch is CancellationError {
            if let client { Task { await client.logout() } }  // a new task: this one is cancelled
        } catch {
            await client?.logout()
            enrollStep = .failed(Self.message(for: error))
        }
    }

    private func poll<T>(_ windowMs: Int, _ step: () async throws -> T?) async throws -> T {
        try await SyncRetry.poll(windowMs: windowMs, intervalMs: SyncDevice.ackPollMs, now: { self.nowMs },
                                 sleep: { try await Task.sleep(nanoseconds: $0) }, step)
    }

    func refresh() async {
        guard phase == .ready || phase == .removed, let device, let mega, !refreshing else { return }
        refreshing = true; defer { refreshing = false }
        do {
            let rec = SyncRecordingStore(remote: mega)
            if let s = try await device.readSnapshot(rec, nowMs: nowMs) {  // nil: the first snapshot is not there yet
                snapshot = s
                Self.write(rec.fetched, "snapshot-cache.json")
            }
            phase = .ready
            var resend: [String] = []
            let replies = try await device.readReplies(mega, requestIds: queued.filter(\.isPending).map(\.id), nowMs: nowMs)
            for i in queued.indices {
                guard let r = replies[queued[i].id] else { continue }
                switch r {
                case .answered(let text, _): queued[i].answer = text
                case .failed(let code):
                    queued[i].code = code
                    if code == "stale_epoch" { resend.append(queued[i].text) }
                }
            }
            let cutoff = nowMs - 7 * 86_400_000
            queued.removeAll { $0.issuedAtMs < cutoff || $0.code == "stale_epoch" }
            Self.write(queued, "queue.json")
            lastError = nil
            for text in resend { await send(text) }
        } catch { fail(error) }
    }

    func send(_ text: String) async {
        guard phase == .ready, let device, let mega else { return }
        do {
            let id = try await device.sendRequest(mega, text: text, nowMs: nowMs)
            queued.append(Queued(id: id, text: text, issuedAtMs: nowMs))
            Self.write(queued, "queue.json"); lastError = nil
        } catch { fail(error) }
    }

    func signIn(password: String) async {
        guard let device else { return }
        let folder = String(device.state.pair.st.dropFirst("mega:".count))
        do {
            let session = try await MegaClient.login(email: megaEmail, password: password)
            _ = Keychain.save(StoredMega(email: megaEmail, folder: folder, session: session), .mega)
            mega = MegaClient(folder: folder, session: session)
            phase = .ready; lastError = nil
            await refresh()
        } catch { lastError = Self.message(for: error) }
    }

    func removeFromPhone() async {
        await mega?.logout()
        for item in [Keychain.Item.state, .keys, .mega] { Keychain.delete(item) }
        try? FileManager.default.removeItem(at: Self.dir)
        device = nil; mega = nil; snapshot = nil; queued = []; lastError = nil; megaEmail = ""
        phase = .off
    }

    func setForeground(_ on: Bool) {
        foregroundTask?.cancel(); foregroundTask = nil
        guard on else { return }
        foregroundTask = Task { [weak self] in
            await self?.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if self.queued.contains(where: \.isPending) { await self.refresh() }
            }
        }
    }

    private func fail(_ error: Error) {
        if let f = error as? MegaClient.Failure, f == .sessionExpired || f == .authFailed {
            Keychain.delete(.mega); mega = nil; phase = .needsPassword
        }
        if (error as? SyncCryptoError)?.code == "removed" { phase = .removed }
        lastError = Self.message(for: error)
    }

    static func message(for error: Error) -> String {
        if let f = error as? MegaClient.Failure {
            switch f {
            case .authFailed: return "MEGA refused the email or password."
            case .mfaRequired: return "This MEGA account has two-step login on. Use the dedicated LLM-IDE account, with two-step login off."
            case .sessionExpired: return "Your MEGA sign-in ended. Sign in again."
            case .accountVersion: return "This MEGA account is too old for this app. Create a new dedicated account."
            case .rateLimited: return "MEGA is busy. Try again in a minute."
            case .quota: return "The MEGA account is over its storage or transfer quota."
            case .tooLarge, .badResponse, .http, .api: return "Couldn't read from MEGA (\(f))."
            }
        }
        if error is URLError { return "No connection to MEGA." }
        switch (error as? SyncCryptoError)?.code {
        case "removed": return "This iPhone was removed from sync. Set it up again from the desktop."
        case "updating": return "The desktop is updating the snapshot. Pull to refresh in a moment."
        case "too_long": return "That prompt is too long."
        case "empty": return "Type a prompt first."
        case "timeout": return "The desktop didn't answer in time. Start again on the desktop."
        case "bad_desktop_key": return "This code doesn't match the desktop's key. Start again on the desktop."
        case "ack_mismatch": return "Someone else answered this pairing code. Start again on the desktop and keep the code private."
        case let code?: return "The sync folder holds data this iPhone cannot verify (\(code)). Nothing from it is shown."
        case nil: return "Something went wrong."
        }
    }

    static func replyText(_ code: String) -> String {
        switch code {
        case "expired": return "Too old when the desktop saw it, or this iPhone's clock is wrong."
        case "quota": return "Today's limit for queued prompts was reached."
        case "needs_approval": return "The desktop needed an approval it can't take from a queued prompt."
        case "turn_failed": return "The desktop could not finish this prompt."
        case "refused": return "The desktop refused this prompt."
        default: return "The desktop could not answer (\(code))."
        }
    }

    private static var dir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("sync", isDirectory: true)
    }
    private static func write<T: Encodable>(_ value: T, _ name: String) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: dir.appendingPathComponent(name), options: [.atomic, .completeFileProtection])
    }
    private static func read<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    enum Keychain {
        enum Item: String { case state = "device-state", keys = "device-keys", mega = "mega-session" }
        private static func base(_ item: Item) -> [String: Any] {
            [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.llmide.sync", kSecAttrAccount as String: item.rawValue]
        }
        @discardableResult
        static func save<T: Encodable>(_ value: T, _ item: Item) -> Bool {
            delete(item)
            guard let data = try? JSONEncoder().encode(value) else { return false }
            var q = base(item)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
        }
        static func load<T: Decodable>(_ type: T.Type, _ item: Item) -> T? {
            var q = base(item)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: AnyObject?
            guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
            return try? JSONDecoder().decode(type, from: data)
        }
        static func delete(_ item: Item) { SecItemDelete(base(item) as CFDictionary) }
    }
}

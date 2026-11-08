import Foundation
import CryptoKit

/// The device's half of the sync store (design 2.1). Paths are relative to the store root. `createFolders` = how many
/// of the path's last parent folders `put` may create: the device creates only `in/` (1) and `e/<slot>/` (2). A folder
/// the user deleted to revoke this phone (`<sid>/d/<dir>`) is therefore never recreated (design 5.3).
@MainActor
public protocol SyncRemoteStore: AnyObject {
    func get(_ path: String) async throws -> Data?
    func put(_ path: String, _ bytes: Data, createFolders: Int) async throws
}

public enum SyncPath {
    public static let maxFileBytes = 1_048_576 + 4_096
    public static func check(_ path: String) throws -> [String] {
        let segs = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard (1...6).contains(segs.count), segs.allSatisfy(valid) else { throw SyncCryptoError("bad_path") }
        return segs
    }
    static func valid(_ s: String) -> Bool {
        s != "." && s != ".." && (1...64).contains(s.utf8.count) && s.utf8.allSatisfy { SyncB64.isB64uByte($0) || $0 == 0x2e }
    }
}

/// In-memory files: the test store, and the offline cache (last fetched ciphertext, re-verified on launch).
@MainActor
public final class SyncDictionaryStore: SyncRemoteStore {
    public var files: [String: Data]
    public init(files: [String: Data] = [:]) { self.files = files }
    public func get(_ path: String) async throws -> Data? { _ = try SyncPath.check(path); return files[path] }
    public func put(_ path: String, _ bytes: Data, createFolders: Int) async throws { _ = try SyncPath.check(path); files[path] = bytes }
}

/// Passes through and keeps every file it fetched, so a verified read can be cached as ciphertext.
@MainActor
public final class SyncRecordingStore: SyncRemoteStore {
    private let remote: SyncRemoteStore
    public private(set) var fetched: [String: Data] = [:]
    public init(remote: SyncRemoteStore) { self.remote = remote }
    public func get(_ path: String) async throws -> Data? {
        let d = try await remote.get(path)
        if let d { fetched[path] = d }
        return d
    }
    public func put(_ path: String, _ bytes: Data, createFolders: Int) async throws {
        try await remote.put(path, bytes, createFolders: createFolders)
    }
}

/// Everything the device keeps between launches. `pair.es` is non-empty only while enrolling.
public struct SyncDeviceState: Codable, Equatable, Sendable {
    public struct PrevReply: Codable, Equatable, Sendable {
        public var epoch: Int
        public var key: Data
        public var untilMs: Int
    }
    public var pair: SyncPair
    public var tier: String
    public var name: String
    public var deviceId: String
    public var desktopSpki: Data
    public var claimName: String
    public var userId: String?
    public var epoch = 0
    public var wrapKeys: SyncWrapKeys?
    public var prevReply: PrevReply?
    public var manifestSeq = 0
    public var requestSeq = 0
    public var isEnrolled: Bool { wrapKeys != nil && userId != nil }

    public init(pair: SyncPair, tier: String, name: String, deviceId: String, desktopSpki: Data, claimName: String) {
        self.pair = pair; self.tier = tier; self.name = name; self.deviceId = deviceId
        self.desktopSpki = desktopSpki; self.claimName = claimName
    }
}

/// The sync v1 device; a port of extension/tests/helpers/sync-device.mjs. Every file read is untrusted until it
/// verifies under the desktop key pinned from the QR.
@MainActor
public final class SyncDevice {
    public static let ackPollMs = 2_000, ackWindowMs = 150_000, wrapWindowMs = 300_000, prevReplyMs = 86_400_000
    public static let maxText = 4_000, maxRequestBytes = 65_536
    static let kinds: Set<String> = ["chats", "meetings", "plans", "usage"]

    public private(set) var state: SyncDeviceState {
        didSet { if state != oldValue { onStateChange?(state) } }
    }
    public var onStateChange: ((SyncDeviceState) -> Void)?
    public let keys: SyncDeviceKeys
    private let desktopKey: P256.Signing.PublicKey
    private var enrollKeys: SyncEnrollKeys?
    private var claimBytes: Data?

    private var base: String { "\(state.pair.sid)/d/\(state.pair.dir)" }
    private var slotDir: String { "\(state.pair.sid)/e/\(state.pair.slot)" }
    private var claim: SyncClaimFields {
        SyncClaimFields(deviceId: state.deviceId, ecdhSpki: keys.ecdhSpki, signingSpki: keys.signingSpki, name: state.name)
    }

    public init(state: SyncDeviceState, keys: SyncDeviceKeys) throws {
        guard state.deviceId == SyncEnroll.deviceId(signingSpki: keys.signingSpki) else { throw SyncCryptoError("bad_key") }
        self.state = state
        self.keys = keys
        desktopKey = try SyncSpki.signingKey(state.desktopSpki)
    }

    /// Contract 4b-4c: key.bin must hash to `sfp` from the QR and be a canonical P-256 SPKI; pin it; write the claim once.
    public static func begin(pair: SyncPair, tier: String = "ios", name: String, keys: SyncDeviceKeys,
                             store: SyncRemoteStore, nowMs: Int) async throws -> SyncDevice {
        let d = try await prepare(pair: pair, tier: tier, name: name, keys: keys, store: store, nowMs: nowMs)
        try await d.writeClaim(store)
        return d
    }

    /// Contract 4b: pin key.bin and seal the claim, writing nothing. Keep the result across retries: `writeClaim` then
    /// writes the same name and bytes again, never a second claim (a second claim kills the slot, contract 4c).
    public static func prepare(pair: SyncPair, tier: String = "ios", name: String, keys: SyncDeviceKeys,
                               store: SyncRemoteStore, nowMs: Int) async throws -> SyncDevice {
        guard let spki = try await store.get("\(pair.sid)/d/\(pair.dir)/key.bin"),
              SyncB64.encode(SyncCrypto.sha256(spki)) == pair.sfp else { throw SyncCryptoError("bad_desktop_key") }
        guard let es = SyncB64.decode(pair.es) else { throw SyncCryptoError("bad_secret") }
        let state = SyncDeviceState(pair: pair, tier: tier, name: name, deviceId: SyncEnroll.deviceId(signingSpki: keys.signingSpki),
                                    desktopSpki: spki, claimName: SyncB64.newId22())
        let d = try SyncDevice(state: state, keys: keys)
        d.enrollKeys = try SyncEnroll.enrollKeys(es: es, sid: pair.sid, slot: pair.slot)
        d.claimBytes = try SyncEnroll.sealClaim(pair: pair, tier: tier, name: name, keys: keys, issuedAt: nowMs).data()
        return d
    }

    public func writeClaim(_ store: SyncRemoteStore) async throws {
        guard let claimBytes else { throw SyncCryptoError("not_enrolling") }
        let path = "\(slotDir)/\(state.claimName).bin"
        // A retry must not add a second claim node: MEGA keeps duplicate names, and the desktop kills a slot with two claims.
        if try await store.get(path) == claimBytes { return }
        try await store.put(path, claimBytes, createFolders: 2)
    }

    /// Contract 4d: nil until the desktop answered, then the 6-digit SAS.
    public func readAck(_ store: SyncRemoteStore) async throws -> String? {
        guard let ek = enrollKeys else { throw SyncCryptoError("not_enrolling") }
        guard let bytes = try await store.get("\(slotDir)/ack.bin") else { return nil }
        let r = try SyncEnroll.openAck(try SyncEnvelope.parse(bytes), pair: state.pair, tier: state.tier, claim: claim, keys: ek,
                                       desktopVerifyKey: desktopKey)
        state.userId = r.userId
        return SyncEnroll.sasCode(sasKey: ek.sas, pair: state.pair, tier: state.tier, claim: claim, nD: r.nD)
    }

    /// Contract 4e and 5 (rotation): true once a wrap for a higher epoch verified; `es` and E(*) are then dropped.
    public func readWrap(_ store: SyncRemoteStore, nowMs: Int) async throws -> Bool {
        guard let userId = state.userId else { throw SyncCryptoError("not_enrolling") }
        guard let bytes = try await store.get("\(base)/wrap.bin") else { return false }
        let env = try SyncEnvelope.parse(bytes)
        guard env.tier == state.tier, env.from == state.pair.sid, env.desktopId == state.pair.sid, env.userId == userId else {
            throw SyncCryptoError("bad_wrap")
        }
        guard env.epoch > state.epoch else { return false }
        let wk = try SyncWrap.unwrap(env, keys: keys, desktopSigningSpki: state.desktopSpki, verifyKey: desktopKey,
                                     currentEpoch: state.epoch, deviceId: state.deviceId)
        var next = state
        if let old = next.wrapKeys { next.prevReply = .init(epoch: next.epoch, key: old.reply, untilMs: nowMs + Self.prevReplyMs) }
        next.wrapKeys = wk
        next.epoch = env.epoch
        next.pair.es = ""
        state = next
        enrollKeys = nil
        claimBytes = nil
        return true
    }

    /// nil = no snapshot yet: manifest.bin is missing but key.bin is there (the desktop publishes up to 60 s after
    /// confirm). Only a missing key.bin means this device's folder was deleted ("removed").
    public func readSnapshot(_ store: SyncRemoteStore, nowMs: Int) async throws -> SyncSnapshot? {
        try await readSnapshot(store, nowMs: nowMs, retry: true)
    }

    private func readSnapshot(_ store: SyncRemoteStore, nowMs: Int, retry: Bool) async throws -> SyncSnapshot? {
        guard let userId = state.userId, state.wrapKeys != nil else { throw SyncCryptoError("not_enrolled") }
        guard let raw = try await store.get("\(base)/manifest.bin") else {
            guard try await store.get("\(base)/key.bin") != nil else { throw SyncCryptoError("removed") }
            return nil
        }
        let env = try SyncEnvelope.parse(raw)
        if env.epoch > state.epoch {
            guard try await readWrap(store, nowMs: nowMs) else { throw SyncCryptoError("bad_epoch") }
        }
        guard let wk = state.wrapKeys else { throw SyncCryptoError("not_enrolled") }
        let sid = state.pair.sid
        let plain = try SyncCrypto.open(env, key: wk.manifest, verifyKey: desktopKey, expect: [
            ("purpose", "manifest"), ("userId", .s(userId)), ("desktopId", .s(sid)), ("from", .s(sid)),
            ("to", .s(state.deviceId)), ("epoch", .i(state.epoch)),
        ])
        guard let m = try? JSONDecoder().decode(SyncManifest.self, from: plain), m.v == 1, m.manifestSeq == env.seq, m.epoch == env.epoch
        else { throw SyncCryptoError("bad_manifest") }
        guard m.manifestSeq >= state.manifestSeq else { throw SyncCryptoError("rollback") }
        // C5: the desktop may have been off past the grace window; its keys may have rotated, so refuse before any
        // blob is fetched or trusted. The same rule is vector-pinned for Node and Swift (`devicePolicy`).
        guard SyncPolicy.manifestState(validUntil: m.validUntil, nowMs: nowMs) != .staleManifest else {
            throw SyncCryptoError("stale_manifest")
        }
        var snap = SyncSnapshot(manifest: m)
        for (kind, e) in m.kinds.sorted(by: { $0.key < $1.key }) {
            guard Self.kinds.contains(kind), Self.isBlobName(e.file) else { throw SyncCryptoError("bad_manifest") }
            guard let bytes = try await store.get("\(base)/\(e.file)") else {
                if retry { return try await readSnapshot(store, nowMs: nowMs, retry: false) }
                throw SyncCryptoError("updating")
            }
            guard SyncCrypto.hex(SyncCrypto.sha256(bytes)) == e.sha256 else { throw SyncCryptoError("bad_blob") }
            let pt = try SyncCrypto.open(try SyncEnvelope.parse(bytes), key: wk.snapshot, verifyKey: desktopKey, expect: [
                ("purpose", "snapshot"), ("userId", .s(userId)), ("desktopId", .s(sid)), ("from", .s(sid)),
                ("to", .s(state.deviceId)), ("epoch", .i(state.epoch)), ("seq", .i(e.seq)),
            ])
            try Self.decode(kind, pt, into: &snap)
        }
        var next = state
        next.manifestSeq = m.manifestSeq
        if let p = next.prevReply, nowMs >= p.untilMs { next.prevReply = nil }
        state = next
        return snap
    }

    static func isBlobName(_ f: String) -> Bool {
        let u = Array(f.utf8)
        guard u.count == 2 + 32 + 4, f.hasPrefix("s/"), f.hasSuffix(".bin") else { return false }
        return u[2..<34].allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    static func frame<T: Codable & Equatable & Sendable>(_: T.Type, _ kind: String, _ pt: Data) throws -> SyncKindFrame<T> {
        guard let f = try? JSONDecoder().decode(SyncKindFrame<T>.self, from: pt), f.v == 1, f.kind == kind else {
            throw SyncCryptoError("bad_blob")
        }
        return f
    }

    static func decode(_ kind: String, _ pt: Data, into s: inout SyncSnapshot) throws {
        var truncated = false
        switch kind {
        case "chats": let f = try frame(SyncChat.self, kind, pt); s.chats = f.items; truncated = f.truncated
        case "meetings": let f = try frame(SyncMeeting.self, kind, pt); s.meetings = f.items; truncated = f.truncated
        case "plans": let f = try frame(SyncPlan.self, kind, pt); s.plans = f.items; truncated = f.truncated
        default: let f = try frame(HostApiUsageGetResult.self, kind, pt); s.usage = f.items.first; truncated = f.truncated
        }
        if truncated { s.truncated.insert(kind) }
    }

    public func sendRequest(_ store: SyncRemoteStore, text: String, nowMs: Int) async throws -> String {
        guard let wk = state.wrapKeys, let userId = state.userId else { throw SyncCryptoError("not_enrolled") }
        guard !text.isEmpty else { throw SyncCryptoError("empty") }
        guard text.utf16.count <= Self.maxText else { throw SyncCryptoError("too_long") }
        let requestId = SyncB64.newId22()
        let enc = JSONEncoder()
        enc.outputFormatting = .sortedKeys
        let plain = try enc.encode(SyncRequestPlain(requestId: requestId, text: text))
        let seq = state.requestSeq + 1
        let header = SyncHeader(purpose: "request", userId: userId, desktopId: state.pair.sid, from: state.deviceId, to: state.pair.sid,
                                epoch: state.epoch, session: "", seq: seq, issuedAt: nowMs, tier: "")
        let bytes = try SyncCrypto.seal(header: header, key: wk.request, plaintext: plain, signer: keys.sign).data()
        guard bytes.count <= Self.maxRequestBytes else { throw SyncCryptoError("too_long") }
        let ms = String(nowMs)
        try await store.put("\(base)/in/\(String(repeating: "0", count: max(0, 13 - ms.count)) + ms)-\(requestId).bin", bytes, createFolders: 1)
        state.requestSeq = seq
        return requestId
    }

    /// Every reply that has arrived, by request id. One that fails to open (an old epoch past its 24 h, a corrupt or
    /// forged file) is skipped so it cannot block the others; it stays pending and ages out. Store errors (network,
    /// session) still throw: they say nothing about one reply.
    public func readReplies(_ store: SyncRemoteStore, requestIds: [String], nowMs: Int) async throws -> [String: SyncReply] {
        var out: [String: SyncReply] = [:]
        for id in requestIds {
            do { if let r = try await readReply(store, requestId: id, nowMs: nowMs) { out[id] = r } }
            catch let e where SyncRetry.isTransient(e) || e as? MegaClient.Failure == .sessionExpired || e as? MegaClient.Failure == .authFailed {
                throw e
            } catch {}
        }
        return out
    }

    public func readReply(_ store: SyncRemoteStore, requestId: String, nowMs: Int) async throws -> SyncReply? {
        guard let wk = state.wrapKeys, let userId = state.userId else { throw SyncCryptoError("not_enrolled") }
        guard let bytes = try await store.get("\(base)/out/\(requestId).bin") else { return nil }
        let env = try SyncEnvelope.parse(bytes)
        let key: Data
        if env.epoch == state.epoch { key = wk.reply }
        else if let p = state.prevReply, p.epoch == env.epoch, nowMs < p.untilMs { key = p.key }
        else { throw SyncCryptoError("bad_epoch") }
        let sid = state.pair.sid
        let pt = try SyncCrypto.open(env, key: key, verifyKey: desktopKey, expect: [
            ("purpose", "reply"), ("userId", .s(userId)), ("desktopId", .s(sid)), ("from", .s(sid)), ("to", .s(state.deviceId)),
        ])
        return try SyncReply.parse(pt, requestId: requestId)
    }
}

/// Polling the store during enrollment: a transient error backs off and polls again instead of ending the enrollment.
public enum SyncRetry {
    public static let maxBackoffMs = 30_000

    /// No network, a MEGA server error, busy (EAGAIN after the client's own retries) or over quota for now.
    public static func isTransient(_ e: Error) -> Bool {
        if let u = e as? URLError { return u.code != .cancelled }
        switch e as? MegaClient.Failure {
        case .rateLimited?, .quota?: return true
        case .http(let code)?: return code == 429 || (500...599).contains(code)
        default: return false
        }
    }

    /// Calls `step` until it returns a value. nil waits `intervalMs`; a transient error waits 2x, 4x... (up to 30 s);
    /// anything else is thrown at once. Past `windowMs` the last transient error, else `timeout`, is thrown.
    @MainActor
    public static func poll<T>(windowMs: Int, intervalMs: Int, now: () -> Int, sleep: (UInt64) async throws -> Void,
                               _ step: () async throws -> T?) async throws -> T {
        let deadline = now() + windowMs
        var backoff = intervalMs
        while true {
            var wait = intervalMs
            do {
                if let v = try await step() { return v }
                backoff = intervalMs
                if now() >= deadline { throw SyncCryptoError("timeout") }
            } catch let e where isTransient(e) {
                if now() >= deadline { throw e }
                backoff = min(backoff * 2, maxBackoffMs)
                wait = backoff
            }
            try await sleep(UInt64(wait) * 1_000_000)
        }
    }
}

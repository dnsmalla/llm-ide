import Foundation
import CryptoKit
import Security

// MARK: - Sync v1 envelope, device side
//
// schema/sync/v1 = relay v1 bytes (schema/relay/v1) plus the sync purposes. A port of extension/core/sync-envelope.mjs:
// canonical enc, padding buckets, AES-256-GCM with AAD = enc(header ++ [extra]), ECDSA P-256 P1363 over
// "llmide/<purpose>/v1\0" || enc(header ++ [extra, nonce, ct]), verify before decrypt. The error codes are the Node
// ones; the shared vectors are the contract.

public struct SyncCryptoError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: String
    public init(_ code: String) { self.code = code }
    public var description: String { code }
}

public enum SyncB64 {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    /// base64url without padding; nil for any other character (Node's `B64U` check), so `bad_base64` is exact.
    public static func decode(_ s: String) -> Data? {
        guard s.utf8.allSatisfy(isB64uByte) else { return nil }
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.utf8.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
    public static func isB64uByte(_ c: UInt8) -> Bool {
        (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d || c == 0x5f
    }
    /// 16 random bytes as base64url, 22 characters: the contract's "Id22".
    public static func newId22() -> String { encode(SyncCrypto.randomBytes(16)) }
}

/// One field of the canonical encoding: u32be length, then u64be (integers) or the UTF-8 / raw bytes.
public enum SyncField: Equatable, Sendable {
    case int(Int), str(String), bytes(Data)
}

public enum SyncEnc {
    public static func enc(_ fields: [SyncField]) -> Data {
        var out = Data()
        for f in fields {
            let v: Data
            switch f {
            case .int(let n): v = withUnsafeBytes(of: UInt64(n).bigEndian) { Data($0) }
            case .str(let s): v = Data(s.utf8)
            case .bytes(let b): v = b
            }
            out.append(contentsOf: withUnsafeBytes(of: UInt32(v.count).bigEndian) { Array($0) })
            out.append(v)
        }
        return out
    }

    public static func decode(_ data: Data, count: Int) throws -> [Data] {
        let b = [UInt8](data)
        var out: [Data] = []
        var off = 0
        while off < b.count {
            guard off + 4 <= b.count else { throw SyncCryptoError("bad_encoding") }
            let n = Int(b[off]) << 24 | Int(b[off + 1]) << 16 | Int(b[off + 2]) << 8 | Int(b[off + 3])
            off += 4
            guard off + n <= b.count else { throw SyncCryptoError("bad_encoding") }
            out.append(Data(b[off..<(off + n)]))
            off += n
        }
        guard out.count == count else { throw SyncCryptoError("bad_encoding") }
        return out
    }
}

public enum SyncPadding {
    public static let buckets = [1024, 4096, 16384, 65536, 262_144, 1_048_576]
    public static let maxFrame = 1_048_576 - 4

    public static func pad(_ body: Data) throws -> Data {
        guard body.count <= maxFrame, let size = buckets.first(where: { $0 >= body.count + 4 }) else { throw SyncCryptoError("frame_too_large") }
        var out = [UInt8](repeating: 0, count: size)
        let n = UInt32(body.count)
        out[0] = UInt8(n >> 24); out[1] = UInt8(n >> 16 & 0xff); out[2] = UInt8(n >> 8 & 0xff); out[3] = UInt8(n & 0xff)
        out.replaceSubrange(4..<(4 + body.count), with: body)
        return Data(out)
    }

    public static func unpad(_ data: Data) throws -> Data {
        let b = [UInt8](data)
        guard buckets.contains(b.count) else { throw SyncCryptoError("bad_padding") }
        let n = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
        guard n <= b.count - 4, b[(4 + n)...].allSatisfy({ $0 == 0 }) else { throw SyncCryptoError("bad_padding") }
        return Data(b[4..<(4 + n)])
    }
}

public enum SyncHeaderValue: Equatable, Sendable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral {
    case s(String), i(Int)
    public init(stringLiteral v: String) { self = .s(v) }
    public init(integerLiteral v: Int) { self = .i(v) }
}

public struct SyncHeader: Equatable, Sendable {
    public var purpose: String, userId: String, desktopId: String, from: String, to: String
    public var epoch: Int
    public var session: String
    public var seq: Int
    public var issuedAt: Int
    public var tier: String

    public init(purpose: String, userId: String, desktopId: String, from: String, to: String, epoch: Int,
                session: String, seq: Int, issuedAt: Int, tier: String) {
        self.purpose = purpose; self.userId = userId; self.desktopId = desktopId; self.from = from; self.to = to
        self.epoch = epoch; self.session = session; self.seq = seq; self.issuedAt = issuedAt; self.tier = tier
    }

    /// `headerFields` in core/sync-envelope.mjs: [v, purpose, userId, desktopId, from, to, epoch, session, seq, issuedAt, tier].
    public var fields: [SyncField] {
        [.int(1), .str(purpose), .str(userId), .str(desktopId), .str(from), .str(to), .int(epoch), .str(session), .int(seq), .int(issuedAt), .str(tier)]
    }

    func value(_ key: String) -> SyncHeaderValue? {
        switch key {
        case "purpose": return .s(purpose)
        case "userId": return .s(userId)
        case "desktopId": return .s(desktopId)
        case "from": return .s(from)
        case "to": return .s(to)
        case "epoch": return .i(epoch)
        case "session": return .s(session)
        case "seq": return .i(seq)
        case "issuedAt": return .i(issuedAt)
        case "tier": return .s(tier)
        default: return nil
        }
    }
}

/// The JSON form written to the store (`Buffer.from(JSON.stringify(env))` on the desktop).
public struct SyncEnvelope: Codable, Equatable, Sendable {
    public var v: Int
    public var purpose: String, userId: String, desktopId: String, from: String, to: String
    public var epoch: Int
    public var session: String
    public var seq: Int
    public var issuedAt: Int
    public var tier: String
    public var nonce: String, ct: String, sig: String
    public var eph: String?

    static let fieldNames: Set<String> = ["v", "purpose", "userId", "desktopId", "from", "to", "epoch", "session", "seq",
                                          "issuedAt", "tier", "nonce", "ct", "sig", "eph"]

    public init(header h: SyncHeader, nonce: String, ct: String, sig: String, eph: String?) {
        v = 1; purpose = h.purpose; userId = h.userId; desktopId = h.desktopId; from = h.from; to = h.to; epoch = h.epoch
        session = h.session; seq = h.seq; issuedAt = h.issuedAt; tier = h.tier
        self.nonce = nonce; self.ct = ct; self.sig = sig; self.eph = eph
    }

    public var header: SyncHeader {
        SyncHeader(purpose: purpose, userId: userId, desktopId: desktopId, from: from, to: to, epoch: epoch,
                   session: session, seq: seq, issuedAt: issuedAt, tier: tier)
    }

    /// A store file → envelope, refusing in Node's order: unknown field, version, purpose, then shape and integers.
    public static func parse(_ data: Data) throws -> SyncEnvelope {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              Set(o.keys).isSubset(of: fieldNames) else { throw SyncCryptoError("bad_envelope") }
        guard (o["v"] as? Int) == 1 else { throw SyncCryptoError("bad_version") }
        guard let p = o["purpose"] as? String, SyncCrypto.purposes.contains(p) else { throw SyncCryptoError("bad_purpose") }
        guard let env = try? JSONDecoder().decode(SyncEnvelope.self, from: data) else { throw SyncCryptoError("bad_envelope") }
        guard [env.epoch, env.seq, env.issuedAt].allSatisfy({ $0 >= 0 && $0 <= 9_007_199_254_740_991 }) else {
            throw SyncCryptoError("bad_integer")
        }
        return env
    }

    public func data() -> Data { (try? JSONEncoder().encode(self)) ?? Data() }
}

public enum SyncCrypto {
    public static let purposes: Set<String> = ["request", "reply", "snapshot", "manifest", "syncwrap", "enroll", "enrollack"]

    public static func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        let status = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return d
    }
    public static func sha256(_ d: Data) -> Data { Data(SHA256.hash(data: d)) }
    public static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
    public static func hkdf(_ ikm: Data, salt: Data, info: Data) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: 32)
            .withUnsafeBytes { Data($0) }
    }
    public static func hmac(_ key: Data, _ msg: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: key)))
    }
    /// Constant time for equal lengths.
    public static func equal(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var r: UInt8 = 0
        for (x, y) in zip(a, b) { r |= x ^ y }
        return r == 0
    }

    static func context(_ purpose: String) -> Data { Data("llmide/\(purpose)/v1\u{0}".utf8) }

    /// `seal` in core/sync-envelope.mjs. `signer` returns a 64-byte P1363 ECDSA P-256 signature.
    public static func seal(header: SyncHeader, key: Data, plaintext: Data, signer: (Data) throws -> Data,
                            nonce: Data? = nil, extra: Data = Data()) throws -> SyncEnvelope {
        guard purposes.contains(header.purpose) else { throw SyncCryptoError("bad_purpose") }
        let n = nonce ?? randomBytes(12)
        let fields = header.fields
        let box = try AES.GCM.seal(try SyncPadding.pad(plaintext), using: SymmetricKey(data: key),
                                   nonce: try AES.GCM.Nonce(data: n), authenticating: SyncEnc.enc(fields + [.bytes(extra)]))
        let ct = box.ciphertext + box.tag
        let sig = try signer(context(header.purpose) + SyncEnc.enc(fields + [.bytes(extra), .bytes(n), .bytes(ct)]))
        return SyncEnvelope(header: header, nonce: SyncB64.encode(n), ct: SyncB64.encode(ct), sig: SyncB64.encode(sig),
                            eph: extra.isEmpty ? nil : SyncB64.encode(extra))
    }

    /// `open`: expected header values first (`bad_<field>`), then sizes, then the signature, then AES-GCM, then padding.
    public static func open(_ env: SyncEnvelope, key: Data, verifyKey: P256.Signing.PublicKey,
                            expect: [(String, SyncHeaderValue)] = []) throws -> Data {
        guard purposes.contains(env.purpose) else { throw SyncCryptoError("bad_purpose") }
        let header = env.header
        for (k, v) in expect where header.value(k) != v { throw SyncCryptoError("bad_\(k)") }
        let extra: Data
        if let e = env.eph, !e.isEmpty {
            guard let x = SyncB64.decode(e) else { throw SyncCryptoError("bad_base64") }
            extra = x
        } else { extra = Data() }
        guard let nonce = SyncB64.decode(env.nonce), let ct = SyncB64.decode(env.ct) else { throw SyncCryptoError("bad_base64") }
        guard nonce.count == 12, ct.count >= 16 + SyncPadding.buckets[0] else { throw SyncCryptoError("bad_ciphertext") }
        let fields = header.fields
        let message = context(env.purpose) + SyncEnc.enc(fields + [.bytes(extra), .bytes(nonce), .bytes(ct)])
        guard let raw = SyncB64.decode(env.sig), let sig = try? P256.Signing.ECDSASignature(rawRepresentation: raw),
              verifyKey.isValidSignature(sig, for: message) else { throw SyncCryptoError("bad_signature") }
        let plain: Data
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: Data(ct.prefix(ct.count - 16)), tag: Data(ct.suffix(16)))
            plain = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: SyncEnc.enc(fields + [.bytes(extra)]))
        } catch { throw SyncCryptoError("bad_ciphertext") }
        return try SyncPadding.unpad(plain)
    }
}

public struct SyncWrapKeys: Codable, Equatable, Sendable {
    public var request: Data, reply: Data, snapshot: Data, manifest: Data
    public init(request: Data, reply: Data, snapshot: Data, manifest: Data) {
        self.request = request; self.reply = reply; self.snapshot = snapshot; self.manifest = manifest
    }
}

public enum SyncWrap {
    /// `syncWrapKey` in core/sync-envelope.mjs.
    public static func wrapKey(z: Data, ephSpki: Data, deviceEcdhSpki: Data, epoch: Int, deviceId: String,
                               desktopSigningSpki: Data, tier: String) -> Data {
        let salt = SyncCrypto.sha256(SyncEnc.enc([.bytes(ephSpki), .bytes(deviceEcdhSpki)]))
        let info = SyncEnc.enc([.str("llmide/syncwrap/v1"), .int(epoch), .str(deviceId), .bytes(SyncCrypto.sha256(deviceEcdhSpki)),
                                .bytes(SyncCrypto.sha256(desktopSigningSpki)), .str(tier)])
        return SyncCrypto.hkdf(z, salt: salt, info: info)
    }

    /// `unwrapSync`: same early refusals (purpose, to, epoch), then verify-before-decrypt by the pinned desktop key.
    public static func unwrap(_ env: SyncEnvelope, keys: SyncDeviceKeys, desktopSigningSpki: Data,
                              verifyKey: P256.Signing.PublicKey, currentEpoch: Int, deviceId: String) throws -> SyncWrapKeys {
        guard env.purpose == "syncwrap", let e = env.eph, !e.isEmpty else { throw SyncCryptoError("bad_purpose") }
        guard env.to == deviceId else { throw SyncCryptoError("bad_to") }
        guard env.epoch > currentEpoch else { throw SyncCryptoError("stale_epoch") }
        guard let ephSpki = SyncB64.decode(e) else { throw SyncCryptoError("bad_base64") }
        let z = try keys.sharedSecret(withSpki: ephSpki)
        let key = wrapKey(z: z, ephSpki: ephSpki, deviceEcdhSpki: keys.ecdhSpki, epoch: env.epoch, deviceId: deviceId,
                          desktopSigningSpki: desktopSigningSpki, tier: env.tier)
        let parts = try SyncEnc.decode(try SyncCrypto.open(env, key: key, verifyKey: verifyKey, expect: [("purpose", "syncwrap")]), count: 4)
        guard parts.allSatisfy({ $0.count == 32 }) else { throw SyncCryptoError("bad_wrap") }
        return SyncWrapKeys(request: parts[0], reply: parts[1], snapshot: parts[2], manifest: parts[3])
    }
}

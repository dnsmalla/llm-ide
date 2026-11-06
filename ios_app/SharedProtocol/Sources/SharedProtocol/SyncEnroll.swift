import Foundation
import CryptoKit

/// The pairing QR's sync fields (device contract item 1).
public struct SyncPair: Codable, Equatable, Sendable {
    public var sid: String, sfp: String, dir: String, slot: String, es: String, st: String
    public init(sid: String, sfp: String, dir: String, slot: String, es: String, st: String) {
        self.sid = sid; self.sfp = sfp; self.dir = dir; self.slot = slot; self.es = es; self.st = st
    }
}

public struct SyncEnrollKeys: Equatable, Sendable {
    public let enroll: Data, enrollack: Data, bind: Data, sas: Data
}

public struct SyncClaimFields: Equatable, Sendable {
    public var deviceId: String
    public var ecdhSpki: Data
    public var signingSpki: Data
    public var name: String
    public init(deviceId: String, ecdhSpki: Data, signingSpki: Data, name: String) {
        self.deviceId = deviceId; self.ecdhSpki = ecdhSpki; self.signingSpki = signingSpki; self.name = name
    }
}

/// Sync v1 enrollment, device side (schema/sync/v1/README.md "Enrollment (device contract)").
public enum SyncEnroll {
    public static let nameMax = 64
    static let salt = SyncCrypto.sha256(Data("llmide-sync-enroll-v1".utf8))

    static func isB64u(_ s: String, _ n: Int) -> Bool { s.utf8.count == n && s.utf8.allSatisfy(SyncB64.isB64uByte) }

    /// `mega:<folder>`, `sftp:<lower-case DNS host>`, or `memory:` (the test adapter).
    public static func isStore(_ st: String) -> Bool {
        if st == "memory:" { return true }
        if st.hasPrefix("sftp:") { return isOwnServerHost(String(st.dropFirst(5))) }
        guard st.hasPrefix("mega:") else { return false }
        let f = st.utf8.dropFirst(5)
        return (1...64).contains(f.count) && f.allSatisfy { SyncB64.isB64uByte($0) || $0 == 0x2e }
    }
    public static func isOwnServerHost(_ h: String) -> Bool {
        h.range(of: #"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9]?)\.)+[a-z]{2,63}$"#, options: .regularExpression) != nil
    }

    /// `llmide://pair?…` or `<origin>/#pair=<encoded query>`. Unknown parameters (Host API fields) are ignored.
    public static func parsePair(_ url: String) throws -> SyncPair {
        let bad = SyncCryptoError("bad_pair")
        let query: String
        if url.hasPrefix("llmide://pair?") {
            query = String(url.dropFirst("llmide://pair?".count))
        } else if let r = url.range(of: "#pair=") {
            guard let q = String(url[r.upperBound...]).removingPercentEncoding else { throw bad }
            query = q
        } else { throw bad }
        var items: [String: String] = [:]
        for part in query.split(separator: "&") {
            let kv = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let k = String(kv[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let v = (kv.count > 1 ? String(kv[1]) : "").replacingOccurrences(of: "+", with: " ").removingPercentEncoding
            else { throw bad }
            if items[k] == nil { items[k] = v }
        }
        guard items["sv"] == "1" else { throw bad }
        let p = SyncPair(sid: items["sid"] ?? "", sfp: items["sfp"] ?? "", dir: items["dir"] ?? "", slot: items["slot"] ?? "",
                         es: items["es"] ?? "", st: items["st"] ?? "")
        guard [p.sid, p.dir, p.slot, p.es].allSatisfy({ isB64u($0, 22) }), isB64u(p.sfp, 43), isStore(p.st) else { throw bad }
        return p
    }

    public static func enrollKeys(es: Data, sid: String, slot: String) throws -> SyncEnrollKeys {
        guard es.count == 16 else { throw SyncCryptoError("bad_secret") }
        func k(_ label: String) -> Data { SyncCrypto.hkdf(es, salt: salt, info: SyncEnc.enc([.str(label), .str(sid), .str(slot)])) }
        return SyncEnrollKeys(enroll: k("enroll"), enrollack: k("enrollack"), bind: k("bind"), sas: k("sas"))
    }

    public static func deviceId(signingSpki: Data) -> String { SyncB64.encode(SyncCrypto.sha256(signingSpki).prefix(16)) }

    public static func validName(_ n: String) -> Bool {
        (1...nameMax).contains(n.utf16.count) && !n.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }

    static func bound(_ p: SyncPair, _ tier: String, _ c: SyncClaimFields) -> [SyncField] {
        [.str(p.sid), .str(p.slot), .str(p.dir), .bytes(SyncB64.decode(p.sfp) ?? Data()), .str(tier), .str(c.deviceId),
         .bytes(c.ecdhSpki), .bytes(c.signingSpki), .str(c.name)]
    }

    public static func claimMac(bindKey: Data, pair: SyncPair, tier: String, claim: SyncClaimFields) -> Data {
        SyncCrypto.hmac(bindKey, SyncEnc.enc(bound(pair, tier, claim)))
    }

    public static func claimHash(_ c: SyncClaimFields) -> Data {
        SyncCrypto.sha256(SyncEnc.enc([.str("llmide/sync-claim/v1"), .str(c.deviceId), .bytes(c.ecdhSpki), .bytes(c.signingSpki), .str(c.name)]))
    }

    public static func sasCode(sasKey: Data, pair: SyncPair, tier: String, claim: SyncClaimFields, nD: Data) -> String {
        let h = [UInt8](SyncCrypto.hmac(sasKey, SyncEnc.enc(bound(pair, tier, claim) + [.bytes(nD)])))
        let v = UInt32(h[0]) << 24 | UInt32(h[1]) << 16 | UInt32(h[2]) << 8 | UInt32(h[3])
        let s = String(v % 1_000_000)
        return String(repeating: "0", count: 6 - s.count) + s
    }

    /// Contract 4c: the claim written to e/<slot>/<Id22>.bin; extra = the signing SPKI so the desktop verifies first.
    public static func sealClaim(pair: SyncPair, tier: String, name: String, keys: SyncDeviceKeys, issuedAt: Int,
                                 nonce: Data? = nil) throws -> SyncEnvelope {
        guard tier == "ios" || tier == "web" else { throw SyncCryptoError("bad_tier") }
        guard validName(name) else { throw SyncCryptoError("bad_name") }
        guard let es = SyncB64.decode(pair.es) else { throw SyncCryptoError("bad_secret") }
        let k = try enrollKeys(es: es, sid: pair.sid, slot: pair.slot)
        let c = SyncClaimFields(deviceId: deviceId(signingSpki: keys.signingSpki), ecdhSpki: keys.ecdhSpki, signingSpki: keys.signingSpki, name: name)
        let mac = claimMac(bindKey: k.bind, pair: pair, tier: tier, claim: c)
        let header = SyncHeader(purpose: "enroll", userId: "", desktopId: pair.sid, from: c.deviceId, to: pair.sid, epoch: 0,
                                session: pair.slot, seq: 0, issuedAt: issuedAt, tier: "")
        return try SyncCrypto.seal(header: header, key: k.enroll,
                                   plaintext: SyncEnc.enc([.bytes(c.ecdhSpki), .bytes(c.signingSpki), .str(name), .bytes(mac)]),
                                   signer: keys.sign, nonce: nonce, extra: keys.signingSpki)
    }

    public static func openAck(_ env: SyncEnvelope, pair: SyncPair, tier: String, claim: SyncClaimFields, keys: SyncEnrollKeys,
                               desktopVerifyKey: P256.Signing.PublicKey) throws -> (userId: String, nD: Data) {
        guard tier == "ios" || tier == "web" else { throw SyncCryptoError("bad_tier") }
        let pt = try SyncCrypto.open(env, key: keys.enrollack, verifyKey: desktopVerifyKey, expect: [
            ("purpose", "enrollack"), ("desktopId", .s(pair.sid)), ("from", .s(pair.sid)), ("to", .s(claim.deviceId)),
            ("epoch", 0), ("session", .s(pair.slot)), ("tier", .s(tier)),
        ])
        let p = try SyncEnc.decode(pt, count: 2)
        guard p[0].count == 16, p[1].count == 32 else { throw SyncCryptoError("bad_ack") }
        guard SyncCrypto.equal(p[1], claimHash(claim)) else { throw SyncCryptoError("ack_mismatch") }
        guard (1...128).contains(env.userId.utf8.count), env.userId.utf8.allSatisfy(SyncB64.isB64uByte) else {
            throw SyncCryptoError("bad_userId")
        }
        return (env.userId, p[0])
    }
}

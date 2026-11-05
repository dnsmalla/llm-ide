import Foundation
import CryptoKit
@testable import SharedProtocol

/// A stand-in for the desktop so the device side can be tested end to end without Node. Test code only.
@MainActor
final class SyncTestDesktop {
    let signing: P256.Signing.PrivateKey
    let sid: String
    let userId = "user-AAAAAAAAAAAAAAAAAAAAAA"
    var root = Data(repeating: 0x66, count: 32)
    var epoch = 0
    private var counter = 100
    var spki: Data { signing.publicKey.derRepresentation }

    init(signing: P256.Signing.PrivateKey = .init(), sid: String = SyncB64.newId22()) {
        self.signing = signing
        self.sid = sid
    }

    func next() -> Int { counter += 1; return counter }
    func sign(_ m: Data) throws -> Data { try signing.signature(for: m).rawRepresentation }

    static func subkey(root: Data, userId: String, desktopId: String, purpose: String, epoch: Int, sender: String, recipient: String) -> Data {
        let salt = SyncCrypto.sha256(Data("llmide-relay-v1".utf8) + SyncEnc.enc([.str(userId), .str(desktopId)]))
        return SyncCrypto.hkdf(root, salt: salt, info: SyncEnc.enc([.str(purpose), .int(epoch), .str(""), .str(sender), .str(recipient)]))
    }

    func deviceKeys(_ deviceId: String, epoch e: Int? = nil) -> SyncWrapKeys {
        let ep = e ?? epoch
        func k(_ p: String, _ s: String, _ r: String) -> Data { Self.subkey(root: root, userId: userId, desktopId: sid, purpose: p, epoch: ep, sender: s, recipient: r) }
        return .init(request: k("request", deviceId, sid), reply: k("reply", sid, deviceId),
                     snapshot: k("snapshot", sid, deviceId), manifest: k("manifest", sid, deviceId))
    }

    func makeWrap(deviceId: String, deviceEcdhSpki: Data, tier: String, eph: P256.KeyAgreement.PrivateKey = .init(),
                  nonce: Data? = nil, seq: Int? = nil, issuedAt: Int = 1_762_300_000_002) throws -> SyncEnvelope {
        let z = try eph.sharedSecretFromKeyAgreement(with: SyncSpki.ecdhKey(deviceEcdhSpki)).withUnsafeBytes { Data($0) }
        let ephSpki = eph.publicKey.derRepresentation
        let key = SyncWrap.wrapKey(z: z, ephSpki: ephSpki, deviceEcdhSpki: deviceEcdhSpki, epoch: epoch, deviceId: deviceId,
                                   desktopSigningSpki: spki, tier: tier)
        let k = deviceKeys(deviceId)
        let header = SyncHeader(purpose: "syncwrap", userId: userId, desktopId: sid, from: sid, to: deviceId, epoch: epoch,
                                session: "", seq: seq ?? next(), issuedAt: issuedAt, tier: tier)
        return try SyncCrypto.seal(header: header, key: key, plaintext: SyncEnc.enc([.bytes(k.request), .bytes(k.reply), .bytes(k.snapshot), .bytes(k.manifest)]),
                                   signer: sign, nonce: nonce, extra: ephSpki)
    }
    /// openClaim (core/sync-enroll.mjs): the desktop's checks on a claim, ported for tests and the malicious suite.
    static func openClaim(_ env: SyncEnvelope, pair: SyncPair, tier: String, keys: SyncEnrollKeys) throws -> SyncClaimFields {
        guard tier == "ios" || tier == "web" else { throw SyncCryptoError("bad_tier") }
        guard let e = env.eph, let spki = SyncB64.decode(e) else { throw SyncCryptoError("bad_envelope") }
        let verify = try SyncSpki.signingKey(spki)
        let pt = try SyncCrypto.open(env, key: keys.enroll, verifyKey: verify, expect: [
            ("purpose", "enroll"), ("userId", ""), ("desktopId", .s(pair.sid)), ("to", .s(pair.sid)), ("epoch", 0),
            ("session", .s(pair.slot)), ("seq", 0), ("tier", ""),
        ])
        let p = try SyncEnc.decode(pt, count: 4)
        guard p[1] == spki else { throw SyncCryptoError("bad_key") }
        _ = try SyncSpki.ecdhKey(p[0])
        guard let name = String(data: p[2], encoding: .utf8), SyncEnroll.validName(name), Data(name.utf8) == p[2] else {
            throw SyncCryptoError("bad_name")
        }
        let c = SyncClaimFields(deviceId: SyncEnroll.deviceId(signingSpki: p[1]), ecdhSpki: p[0], signingSpki: p[1], name: name)
        guard env.from == c.deviceId else { throw SyncCryptoError("bad_from") }
        guard SyncCrypto.equal(p[3], SyncEnroll.claimMac(bindKey: keys.bind, pair: pair, tier: tier, claim: c)) else {
            throw SyncCryptoError("bad_mac")
        }
        return c
    }

}

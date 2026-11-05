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

    var pair: SyncPair!
    var enroll: SyncEnrollKeys!
    var tier = "ios"
    var base: String { "\(sid)/d/\(pair.dir)" }

    /// design 5.2 step 1: open a slot, write key.bin, return the iPhone QR.
    func openSlot(_ store: SyncDictionaryStore) -> String {
        let es = SyncCrypto.randomBytes(16)
        pair = SyncPair(sid: sid, sfp: SyncB64.encode(SyncCrypto.sha256(spki)), dir: SyncB64.newId22(), slot: SyncB64.newId22(),
                        es: SyncB64.encode(es), st: "memory:")
        enroll = try! SyncEnroll.enrollKeys(es: es, sid: sid, slot: pair.slot)
        store.files["\(base)/key.bin"] = spki
        return "llmide://pair?sv=1&sid=\(pair.sid)&sfp=\(pair.sfp)&dir=\(pair.dir)&slot=\(pair.slot)&es=\(pair.es)&st=memory%3A"
    }

    /// Pin the one claim in the slot. More than one claim file kills the slot (`contested`), as enroll.mjs does.
    func pinClaim(_ store: SyncDictionaryStore) throws -> SyncClaimFields {
        let claims = store.files.filter { $0.key.hasPrefix("\(sid)/e/\(pair.slot)/") && !$0.key.hasSuffix("/ack.bin") }
        guard claims.count == 1, let bytes = claims.first?.value else { throw SyncCryptoError("contested") }
        return try Self.openClaim(try SyncEnvelope.parse(bytes), pair: pair, tier: tier, keys: enroll)
    }

    /// The one signed ack, bound to the pinned claim and a fresh nD. Returns the desktop's SAS.
    @discardableResult
    func writeAck(_ store: SyncDictionaryStore, for c: SyncClaimFields, nD: Data = SyncCrypto.randomBytes(16)) throws -> String {
        let h = SyncHeader(purpose: "enrollack", userId: userId, desktopId: sid, from: sid, to: c.deviceId, epoch: 0, session: pair.slot,
                           seq: next(), issuedAt: 1_762_300_000_200, tier: tier)
        let env = try SyncCrypto.seal(header: h, key: enroll.enrollack, plaintext: SyncEnc.enc([.bytes(nD), .bytes(SyncEnroll.claimHash(c))]), signer: sign)
        store.files["\(sid)/e/\(pair.slot)/ack.bin"] = env.data()
        return SyncEnroll.sasCode(sasKey: enroll.sas, pair: pair, tier: tier, claim: c, nD: nD)
    }

    /// "Codes match": epoch up, wrap, publish, then delete the slot (design 5.2 step 4).
    func confirm(_ store: SyncDictionaryStore, _ c: SyncClaimFields) throws {
        epoch += 1
        store.files["\(base)/wrap.bin"] = try makeWrap(deviceId: c.deviceId, deviceEcdhSpki: c.ecdhSpki, tier: tier).data()
        try publish(store, c)
        for k in store.files.keys where k.hasPrefix("\(sid)/e/\(pair.slot)/") { store.files[k] = nil }
    }

    func seal(_ purpose: String, to deviceId: String, seq: Int, key: Data, _ plain: Data, epoch e: Int? = nil) throws -> SyncEnvelope {
        try SyncCrypto.seal(header: SyncHeader(purpose: purpose, userId: userId, desktopId: sid, from: sid, to: deviceId, epoch: e ?? epoch,
                                               session: "", seq: seq, issuedAt: 1_762_300_000_000, tier: ""),
                            key: key, plaintext: plain, signer: sign)
    }

    /// producer.mjs publishOnce for one device: fresh blob names, then the manifest. Returns kind → blob path.
    @discardableResult
    func publish(_ store: SyncDictionaryStore, _ c: SyncClaimFields, frames: [String: String]? = nil,
                 now: Int = 1_762_300_000_000, validFor: Int = 2_700_000) throws -> [String: String] {
        let dk = deviceKeys(c.deviceId)
        var entries: [String: Any] = [:], paths: [String: String] = [:]
        for (kind, json) in (frames ?? Self.sampleFrames(now)).sorted(by: { $0.key < $1.key }) {
            let s = next()
            let bytes = try seal("snapshot", to: c.deviceId, seq: s, key: dk.snapshot, Data(json.utf8)).data()
            let file = "s/\(SyncCrypto.hex(SyncCrypto.randomBytes(16))).bin"
            store.files["\(base)/\(file)"] = bytes
            entries[kind] = ["file": file, "seq": s, "sha256": SyncCrypto.hex(SyncCrypto.sha256(bytes))]
            paths[kind] = "\(base)/\(file)"
        }
        let ms = next()
        let manifest: [String: Any] = ["v": 1, "manifestSeq": ms, "epoch": epoch, "generatedAt": now, "validUntil": now + validFor, "kinds": entries]
        store.files["\(base)/manifest.bin"] = try seal("manifest", to: c.deviceId, seq: ms, key: dk.manifest,
                                                       JSONSerialization.data(withJSONObject: manifest)).data()
        return paths
    }

    /// The inbox as the consumer opens it: by the registered device key, the request key, closed schema.
    func readRequests(_ store: SyncDictionaryStore, _ c: SyncClaimFields) throws -> [(name: String, plain: [String: Any])] {
        let verify = try SyncSpki.signingKey(c.signingSpki)
        return try store.files.filter { $0.key.hasPrefix("\(base)/in/") }.sorted { $0.key < $1.key }.map { path, bytes in
            let pt = try SyncCrypto.open(try SyncEnvelope.parse(bytes), key: deviceKeys(c.deviceId).request, verifyKey: verify,
                                         expect: [("purpose", "request"), ("from", .s(c.deviceId)), ("to", .s(sid)), ("epoch", .i(epoch))])
            return (String(path.split(separator: "/").last!), try JSONSerialization.jsonObject(with: pt) as! [String: Any])
        }
    }

    func writeReply(_ store: SyncDictionaryStore, _ c: SyncClaimFields, requestId: String, _ body: [String: Any],
                    epoch e: Int? = nil, key: Data? = nil) throws {
        var plain = body
        plain["v"] = 1; plain["requestId"] = requestId
        let env = try seal("reply", to: c.deviceId, seq: next(), key: key ?? deviceKeys(c.deviceId, epoch: e).reply,
                           JSONSerialization.data(withJSONObject: plain), epoch: e)
        store.files["\(base)/out/\(requestId).bin"] = env.data()
    }

    static func sampleFrames(_ now: Int) -> [String: String] {
        [
            "chats": #"{"v":1,"kind":"chats","generatedAt":\#(now),"truncated":false,"items":[{"id":"c1","title":"Release notes","updatedAt":\#(now),"messages":[{"seq":1,"role":"user","content":"hi"},{"seq":2,"role":"assistant","content":"hello"}]},{"id":"c2","title":"Phone chat","updatedAt":\#(now),"phoneChat":true,"messages":[]}]}"#,
            "meetings": #"{"v":1,"kind":"meetings","generatedAt":\#(now),"truncated":true,"items":[{"id":"m1","title":"Standup","date":"2026-11-05","durationSec":900,"participants":["Ann","Bo"],"notes":[{"kind":"decision","text":"Ship Friday"},{"kind":"action","text":"Bo writes notes"}]}]}"#,
            "plans": #"{"v":1,"kind":"plans","generatedAt":\#(now),"truncated":false,"items":[{"id":"p1","title":"Sync","goal":"Phone offline","updatedAt":\#(now),"tasks":[{"title":"SP4","status":"doing","owner":"me","due":null,"milestone":"M1","risk":"low"}]}]}"#,
            "usage": #"{"v":1,"kind":"usage","generatedAt":\#(now),"truncated":false,"items":[{"providers":[{"provider":"claude","status":"ok","models":[{"model":"claude-sonnet","state":"ok","unit":"runs","window":"daily","used":3,"limit":10,"pct":30,"resetAt":0}]}]}]}"#,
        ]
    }

}

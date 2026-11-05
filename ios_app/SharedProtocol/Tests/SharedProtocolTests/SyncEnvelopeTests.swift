import Testing
import Foundation
import CryptoKit
@testable import SharedProtocol

@MainActor
@Suite("Sync v1 envelope (CryptoKit) against the shared vectors")
struct SyncEnvelopeTests {
    @Test("relay v1: canonical enc, padding and the AAD are byte-identical")
    func relayPrimitives() throws {
        let canon = SV.d(SV.relay["canonical"])
        #expect(SyncCrypto.hex(SyncEnc.enc([.int(1), .str("ab"), .str("")])) == SV.s(canon["hex"]))
        let pad = SV.d(SV.relay["padding"])
        #expect(try SyncPadding.pad(Data(count: pad["frameLen"] as! Int)).count == pad["bucket"] as! Int)
        let e = SV.d(SV.relay["envelope"])
        let env = try SV.env(e["env"])
        #expect(SyncCrypto.hex(SyncEnc.enc(env.header.fields + [.bytes(Data())])) == SV.s(e["aadHex"]))
    }

    @Test("relay v1 request: our seal with the vector nonce gives the vector ct, and the vector opens")
    func relayRequest() throws {
        let e = SV.d(SV.relay["envelope"])
        let env = try SV.env(e["env"])
        let keys = SV.d(SV.relay["keys"])
        let signer = try P256.Signing.PrivateKey(derRepresentation: SV.b(keys["deviceSigningPkcs8"]))
        let again = try SyncCrypto.seal(header: env.header, key: SV.hex(e["keyHex"]), plaintext: Data(SV.s(e["frame"]).utf8),
                                        signer: { try signer.signature(for: $0).rawRepresentation }, nonce: SV.hex(e["nonceHex"]))
        #expect(again.ct == env.ct)
        let verify = try SyncSpki.signingKey(SV.b(keys["deviceSigningSpki"]))
        #expect(try SyncCrypto.open(again, key: SV.hex(e["keyHex"]), verifyKey: verify) == Data(SV.s(e["frame"]).utf8))
        for n in SV.relay["negatives"] as! [String] {
            let parts = n.split(separator: ":", maxSplits: 1).map(String.init)
            var m: [String: Any] = [:]
            if parts.count == 2 {
                if parts[0] == "set" {
                    let kv = parts[1].split(separator: "=", maxSplits: 1).map(String.init)
                    m = ["op": "set", "field": kv[0], "value": Int(kv[1]) ?? kv[1]]
                } else { m = ["op": parts[0], "field": parts[1]] }
            }
            let bad = SV.mutate(SV.d(e["env"]), m)
            #expect(throws: SyncCryptoError.self, "\(n)") {
                _ = try SyncCrypto.open(try SV.env(bad), key: SV.hex(e["keyHex"]), verifyKey: verify)
            }
        }
    }

    @Test("sync v1: snapshot, manifest, request and reply open with the per-device keys")
    func syncOpen() throws {
        let k = SV.wrapKeys, desk = try SV.desktopVerify()
        let dev = try SyncSpki.signingKey(SV.b(SV.keys["deviceSigningSpki"]))
        for (name, key, verify) in [("snapshot", k.snapshot, desk), ("manifest", k.manifest, desk), ("reply", k.reply, desk), ("request", k.request, dev)] {
            let v = SV.d(SV.sync[name])
            #expect(try SyncCrypto.open(try SV.env(v["env"]), key: key, verifyKey: verify, expect: [("purpose", .s(name))]) == Data(SV.s(v["plaintext"]).utf8), "\(name)")
        }
        #expect(SyncB64.encode(SyncCrypto.sha256(SV.b(SV.keys["desktopSigningSpki"]))) == SV.s(SV.sync["desktopSigningFingerprint"]))
    }

    @Test("sync v1 request: our seal with nonce 0x71 reproduces the vector ct")
    func syncRequestSeal() throws {
        let v = SV.d(SV.sync["request"])
        let env = try SV.env(v["env"])
        let dev = try SV.deviceKeys()
        let again = try SyncCrypto.seal(header: env.header, key: SV.wrapKeys.request, plaintext: Data(SV.s(v["plaintext"]).utf8),
                                        signer: dev.sign, nonce: Data(repeating: 0x71, count: 12))
        #expect(again.ct == env.ct)
    }

    @Test("syncwrap: the vector unwraps to the four keys; our test desktop reproduces the vector ct")
    func syncwrap() throws {
        let ids = SV.d(SV.sync["ids"])
        let env = try SV.env(SV.d(SV.sync["syncwrap"])["env"])
        let keys = try SyncWrap.unwrap(env, keys: try SV.deviceKeys(), desktopSigningSpki: SV.b(SV.keys["desktopSigningSpki"]),
                                       verifyKey: try SV.desktopVerify(), currentEpoch: 0, deviceId: SV.s(ids["deviceId"]))
        #expect(keys == SV.wrapKeys)
        let desk = SyncTestDesktop(signing: try SV.desktopSigning(), sid: SV.s(ids["desktopId"]))
        desk.epoch = SV.sync["epoch"] as! Int
        let k = desk.deviceKeys(SV.s(ids["deviceId"]))
        #expect(k == SV.wrapKeys, "the test desktop's subkeys match the vectors")
        let again = try desk.makeWrap(deviceId: SV.s(ids["deviceId"]), deviceEcdhSpki: SV.b(SV.keys["deviceEcdhSpki"]), tier: "web",
                                      eph: try .init(derRepresentation: SV.b(SV.keys["ephPkcs8"])), nonce: Data(repeating: 0x55, count: 12), seq: 11)
        #expect(again.ct == env.ct)
    }

    @Test("typed negatives: every mutation fails with the code the vectors state")
    func typedNegatives() throws {
        let ids = SV.d(SV.sync["ids"])
        let k = SV.wrapKeys
        let keyOf = ["request": k.request, "reply": k.reply, "snapshot": k.snapshot, "manifest": k.manifest]
        let desk = try SV.desktopVerify()
        let dev = try SyncSpki.signingKey(SV.b(SV.keys["deviceSigningSpki"]))
        let deviceKeys = try SV.deviceKeys()
        for n in SV.sync["typedNegatives"] as! [[String: Any]] {
            let target = SV.s(n["target"]), m = SV.d(n["mutate"]), want = SV.s(n["error"])
            let env = SV.mutate(SV.d(SV.d(SV.sync[target])["env"]), m)
            let op = m["op"] as? String
            if target == "syncwrap" {
                let current = op == "currentEpoch" ? m["value"] as! Int : 0
                #expect(throws: SyncCryptoError(want), "\(target) \(m)") {
                    _ = try SyncWrap.unwrap(try SV.env(env), keys: deviceKeys, desktopSigningSpki: SV.b(SV.keys["desktopSigningSpki"]),
                                            verifyKey: desk, currentEpoch: current, deviceId: SV.s(ids["deviceId"]))
                }
            } else {
                let key = op == "key" ? keyOf[SV.s(m["value"])]! : keyOf[target]!
                let expect: [(String, SyncHeaderValue)] = op == "expect" ? [(SV.s(m["field"]), SV.headerValue(m["value"]))] : []
                let verify = target == "request" ? dev : desk
                #expect(throws: SyncCryptoError(want), "\(target) \(m)") {
                    _ = try SyncCrypto.open(try SV.env(env), key: key, verifyKey: verify, expect: expect)
                }
            }
        }
    }

    @Test("pad/unpad refuse a frame over the cap and padding that is not zero")
    func padding() throws {
        #expect(throws: SyncCryptoError("frame_too_large")) { _ = try SyncPadding.pad(Data(count: SyncPadding.maxFrame + 1)) }
        var p = [UInt8](try SyncPadding.pad(Data([1, 2, 3])))
        p[100] = 1
        #expect(throws: SyncCryptoError("bad_padding")) { _ = try SyncPadding.unpad(Data(p)) }
    }

    @Test("Secure Enclave keys sign and agree like software keys (skipped where there is no Secure Enclave)",
          .enabled(if: SecureEnclaveSyncDeviceKeys.isAvailable))
    func secureEnclave() throws {
        let se = try SecureEnclaveSyncDeviceKeys()
        let restored = try SecureEnclaveSyncDeviceKeys(signingBlob: se.signingBlob, ecdhBlob: se.ecdhBlob)
        #expect(restored.signingSpki == se.signingSpki && restored.ecdhSpki == se.ecdhSpki)
        let msg = Data("x".utf8)
        let sig = try P256.Signing.ECDSASignature(rawRepresentation: try restored.sign(msg))
        #expect(try SyncSpki.signingKey(se.signingSpki).isValidSignature(sig, for: msg))
        let peer = SoftwareSyncDeviceKeys()
        #expect(try se.sharedSecret(withSpki: peer.ecdhSpki) == (try peer.sharedSecret(withSpki: se.ecdhSpki)))
    }
}

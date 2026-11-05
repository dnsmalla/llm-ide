import Testing
import Foundation
import CryptoKit
@testable import SharedProtocol

@MainActor
@Suite("Sync enrollment (device contract) against the enroll vectors")
struct SyncEnrollTests {
    var X: [String: Any] { SV.d(SV.sync["enroll"]) }
    var pair: SyncPair {
        let p = SV.d(X["pair"])
        return SyncPair(sid: SV.s(p["sid"]), sfp: SV.s(p["sfp"]), dir: SV.s(p["dir"]), slot: SV.s(p["slot"]), es: SV.s(p["es"]), st: SV.s(p["st"]))
    }
    var claim: SyncClaimFields {
        SyncClaimFields(deviceId: SV.s(X["deviceId"]), ecdhSpki: SV.b(SV.keys["deviceEcdhSpki"]),
                        signingSpki: SV.b(X["deviceSigningSpki"]), name: SV.s(X["name"]))
    }
    func keys(_ es: String? = nil, _ p: SyncPair? = nil) throws -> SyncEnrollKeys {
        let pp = p ?? pair
        return try SyncEnroll.enrollKeys(es: SyncB64.decode(es ?? pp.es)!, sid: pp.sid, slot: pp.slot)
    }

    @Test("QR: both URL forms parse to the vector pair; Host API fields are ignored; junk is refused")
    func qr() throws {
        #expect(try SyncEnroll.parsePair(SV.s(X["iosUrl"])) == pair)
        #expect(try SyncEnroll.parsePair(SV.s(X["webUrl"])) == pair)
        #expect(try SyncEnroll.parsePair(SV.s(X["iosUrl"]) + "&ip=192.168.1.2&pin=123456&h1port=8443&api=1") == pair)
        let ios = SV.s(X["iosUrl"])
        let bad = [ios.replacingOccurrences(of: "sv=1", with: "sv=2"),
                   ios.replacingOccurrences(of: "es=\(pair.es)", with: "es=short"),
                   ios.replacingOccurrences(of: "st=mega%3Allmide-sync", with: "st=box%3A1"),
                   "https://evil.example/#nope", "llmide://pair?ip=192.168.1.2&pin=123456"]
        for b in bad { #expect(throws: SyncCryptoError("bad_pair"), "\(b)") { _ = try SyncEnroll.parsePair(b) } }
    }

    @Test("derived keys, deviceId, MAC, claim hash and SAS match the reference")
    func derived() throws {
        let k = try keys()
        #expect(SyncCrypto.hex(k.enroll) == SV.s(X["enrollKeyHex"]))
        #expect(SyncCrypto.hex(k.enrollack) == SV.s(X["enrollackKeyHex"]))
        #expect(SyncCrypto.hex(k.bind) == SV.s(X["bindKeyHex"]))
        #expect(SyncCrypto.hex(k.sas) == SV.s(X["sasKeyHex"]))
        #expect(SyncEnroll.deviceId(signingSpki: SV.b(X["deviceSigningSpki"])) == SV.s(X["deviceId"]))
        let tier = SV.s(X["tier"])
        #expect(SyncCrypto.hex(SyncEnroll.claimMac(bindKey: k.bind, pair: pair, tier: tier, claim: claim)) == SV.s(X["macHex"]))
        #expect(SyncCrypto.hex(SyncEnroll.claimHash(claim)) == SV.s(X["claimHashHex"]))
        #expect(SyncEnroll.sasCode(sasKey: k.sas, pair: pair, tier: tier, claim: claim, nD: SV.hex(X["nDHex"])) == SV.s(X["sas"]))
    }

    @Test("claim: our seal with the vector nonce gives the vector ct, and the desktop's checks accept it")
    func claimSeal() throws {
        let env = try SV.env(SV.d(X["claim"])["env"])
        let again = try SyncEnroll.sealClaim(pair: pair, tier: SV.s(X["tier"]), name: SV.s(X["name"]), keys: try SV.deviceKeys(),
                                             issuedAt: env.issuedAt, nonce: SV.hex(SV.d(X["claim"])["nonceHex"]))
        #expect(again.ct == env.ct)
        #expect(try SyncTestDesktop.openClaim(again, pair: pair, tier: SV.s(X["tier"]), keys: try keys()) == claim)
    }

    @Test("ack: the device opens the vector ack with the pinned desktop key")
    func ack() throws {
        let r = try SyncEnroll.openAck(try SV.env(SV.d(X["ack"])["env"]), pair: pair, tier: SV.s(X["tier"]), claim: claim,
                                       keys: try keys(), desktopVerifyKey: try SV.desktopVerify())
        #expect(r.userId == SV.s(X["userId"]))
        #expect(SyncCrypto.hex(r.nD) == SV.s(X["nDHex"]))
    }

    @Test("every enroll negative fails closed with its code (claim side via the desktop port, ack side on the device)")
    func negatives() throws {
        for n in X["negatives"] as! [[String: Any]] {
            let target = SV.s(n["target"]), m = SV.d(n["mutate"]), want = SV.s(n["error"])
            let env = SV.mutate(SV.d(SV.d(X[target])["env"]), m)
            var p = pair, tier = SV.s(X["tier"]), c = claim, es = pair.es
            var verify = try SV.desktopVerify()
            if m["op"] as? String == "expect" {
                switch SV.s(m["field"]) {
                case "tier": tier = SV.s(m["value"])
                case "es": es = SV.s(m["value"])
                case "name": c.name = SV.s(m["value"])
                case "dir": p.dir = SV.s(m["value"])
                case "sfp": p.sfp = SV.s(m["value"])
                default: Issue.record("unknown field \(m)")
                }
            } else if m["op"] as? String == "verifyKey" {
                verify = try SyncSpki.signingKey(SV.b(SV.keys["deviceSigningSpki"]))
            }
            let k = try SyncEnroll.enrollKeys(es: SyncB64.decode(es)!, sid: p.sid, slot: p.slot)
            #expect(throws: SyncCryptoError(want), "\(target) \(m)") {
                if target == "claim" { _ = try SyncTestDesktop.openClaim(try SV.env(env), pair: p, tier: tier, keys: k) }
                else { _ = try SyncEnroll.openAck(try SV.env(env), pair: p, tier: tier, claim: c, keys: k, desktopVerifyKey: verify) }
            }
        }
    }

    @Test("names: 1 to 64 UTF-16 units, no control characters; sealClaim refuses a bad name or tier")
    func names() throws {
        #expect(SyncEnroll.validName("Dinesh's iPhone"))
        #expect(!SyncEnroll.validName(""))
        #expect(!SyncEnroll.validName(String(repeating: "a", count: 65)))
        #expect(!SyncEnroll.validName("a\nb"))
        #expect(throws: SyncCryptoError("bad_name")) { _ = try SyncEnroll.sealClaim(pair: pair, tier: "ios", name: "", keys: SoftwareSyncDeviceKeys(), issuedAt: 1) }
        #expect(throws: SyncCryptoError("bad_tier")) { _ = try SyncEnroll.sealClaim(pair: pair, tier: "mac", name: "x", keys: SoftwareSyncDeviceKeys(), issuedAt: 1) }
    }
}

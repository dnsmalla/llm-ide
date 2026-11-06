import Testing
import Foundation
@testable import SharedProtocol

@Suite("MEGA crypto (Swift) against megajs 1.3.10")
struct MegaCryptoTests {
    var F: [String: Any] { SV.mega }
    var login: [String: Any] { SV.d(F["login"]) }
    var master: Data { SV.hex(login["masterKeyHex"]) }

    @Test("v2 login: PBKDF2-SHA512 gives megajs's uh; k decrypts to the master key; csid + privk give the session id")
    func loginMath() throws {
        let derived = MegaCrypto.pbkdf2SHA512(password: Data(SV.s(login["password"]).utf8), salt: MegaCrypto.d64(SV.s(login["salt"]))!)
        #expect(SyncB64.encode(derived.suffix(16)) == SV.s(login["uh"]))
        #expect(MegaCrypto.ecbDecrypt(Data(derived.prefix(16)), MegaCrypto.d64(SV.s(login["k"]))!) == master)
        let privk = MegaCrypto.ecbDecrypt(master, MegaCrypto.d64(SV.s(login["privk"]))!)
        #expect(try MegaCrypto.sessionId(csid: MegaCrypto.d64(SV.s(login["csid"]))!, privk: privk) == SV.s(login["sid"]))
    }

    @Test("upload: same key → same ciphertext, node key and attributes as megajs")
    func upload() {
        let u = SV.d(F["upload"])
        let key24 = SV.hex(u["keyHex"]), plain = SV.hex(u["plaintextHex"])
        let aes = Data(key24.prefix(16)), nonce = Data(key24.suffix(8))
        #expect(MegaCrypto.ctr(aes, nonce: nonce, plain) == SV.b(u["ciphertext"]))
        let nodeKey = MegaCrypto.mergeKeyMac(key24, mac: MegaCrypto.condensedMac(key: aes, nonce: nonce, plaintext: plain))
        #expect(SyncB64.encode(MegaCrypto.ecbEncrypt(master, nodeKey)) == SV.s(u["k"]))
        #expect(MegaCrypto.encryptAttributes(name: SV.s(u["name"]), key16: aes) == SV.s(u["a"]))
        #expect(MegaCrypto.decryptAttributes(MegaCrypto.d64(SV.s(u["a"]))!, key: nodeKey) == "hello.bin")
    }

    @Test("folder: same key → same attributes and stored key as megajs mkdir")
    func folder() {
        let m = SV.d(F["mkdir"])
        let key = SV.hex(m["keyHex"])
        #expect(MegaCrypto.encryptAttributes(name: SV.s(m["name"]), key16: key) == SV.s(m["a"]))
        #expect(SyncB64.encode(MegaCrypto.ecbEncrypt(master, key)) == SV.s(m["k"]))
    }

    @Test("download: megajs's multi-chunk upload decrypts and its condensed MAC verifies")
    func multiChunk() throws {
        let bigInfo = SV.d(F["big"])
        let node = (F["nodes"] as! [[String: Any]]).first { $0["h"] as? String == SV.s(bigInfo["h"]) }!
        let enc = MegaCrypto.d64(String(SV.s(node["k"]).split(separator: ":").last!))!
        let key = MegaCrypto.unmergeKeyMac(MegaCrypto.ecbDecrypt(master, enc))
        let plain = MegaCrypto.ctr(Data(key.prefix(16)), nonce: Data(key[16..<24]), SV.b(SV.d(F["blobs"])[SV.s(bigInfo["h"])]))
        #expect(plain.count == bigInfo["size"] as! Int)
        #expect(plain.enumerated().allSatisfy { $0.element == UInt8(($0.offset * 7 + 3) & 255) })
        #expect(MegaCrypto.condensedMac(key: Data(key.prefix(16)), nonce: Data(key[16..<24]), plaintext: plain) == Data(key[24..<32]))
    }

    @Test("hashcash: the same token megajs computed for the same challenge")
    func hashcash() throws {
        let h = SV.d(F["hashcash"])
        #expect(try MegaCrypto.hashcash(SV.s(h["challenge"])) == SV.s(h["token"]))
        #expect(throws: (any Error).self) { _ = try MegaCrypto.hashcash("2:1:1:AAAA") }
    }

    @Test("big integers: small known values")
    func bigInt() throws {
        let r = try MegaBigUInt.modPow(MegaBigUInt(Data([4])), MegaBigUInt(Data([13])), MegaBigUInt(Data([0x01, 0xf1])))
        #expect(r.bigEndianBytes == Data([0x01, 0xbd]))
        #expect((MegaBigUInt(Data([0xff, 0xff])) * MegaBigUInt(Data([0x01, 0x00, 0x01]))).bigEndianBytes == Data([0xff, 0xff, 0xff, 0xff]))
        #expect(MegaBigUInt(Data([0, 0, 7])).bigEndianBytes == Data([7]))
    }

    @Test("a malformed login reply (even or empty RSA modulus) throws badResponse instead of crashing")
    func malformedModulus() throws {
        func mpi(_ b: [UInt8]) -> [UInt8] { [UInt8(b.count * 8 >> 8), UInt8(b.count * 8 & 0xff)] + b }
        let even = mpi([0x02]) + mpi([0x02]) + mpi([0x03])
        #expect(throws: MegaClient.Failure.badResponse) { _ = try MegaCrypto.sessionId(csid: Data(mpi([0x05])), privk: Data(even)) }
        let empty = mpi([]) + mpi([]) + mpi([0x03])
        #expect(throws: MegaClient.Failure.badResponse) { _ = try MegaCrypto.sessionId(csid: Data(mpi([0x05])), privk: Data(empty)) }
    }
}

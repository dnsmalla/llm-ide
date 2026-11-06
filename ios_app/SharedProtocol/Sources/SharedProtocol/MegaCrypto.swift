import Foundation
import CommonCrypto
import CryptoKit

/// MEGA's own client-side format, ported from megajs 1.3.10 and checked against megajs's fixture. OS crypto only.
enum MegaCrypto {
    static func d64(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.utf8.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    private static func crypt(_ op: Int, _ mode: Int, key: Data, iv: Data?, _ input: Data) -> Data {
        precondition(key.count == 16 && (mode == kCCModeCTR || input.count % 16 == 0), "AES block size")
        var ref: CCCryptorRef?
        let ivBytes = iv ?? Data(count: 16)
        let created = key.withUnsafeBytes { k in
            ivBytes.withUnsafeBytes { v in
                CCCryptorCreateWithMode(CCOperation(op), CCMode(mode), CCAlgorithm(kCCAlgorithmAES), CCPadding(ccNoPadding),
                                        mode == kCCModeECB ? nil : v.baseAddress, k.baseAddress, key.count, nil, 0, 0, CCModeOptions(0), &ref)
            }
        }
        precondition(created == CCCryptorStatus(kCCSuccess), "AES setup")
        defer { CCCryptorRelease(ref) }
        var out = Data(count: input.count)
        var moved = 0
        let status = input.withUnsafeBytes { i in
            out.withUnsafeMutableBytes { o in CCCryptorUpdate(ref, i.baseAddress, input.count, o.baseAddress, input.count, &moved) }
        }
        precondition(status == CCCryptorStatus(kCCSuccess) && moved == input.count, "AES update")
        return out
    }

    static func ecbEncrypt(_ key: Data, _ d: Data) -> Data { crypt(kCCEncrypt, kCCModeECB, key: key, iv: nil, d) }
    static func ecbDecrypt(_ key: Data, _ d: Data) -> Data { crypt(kCCDecrypt, kCCModeECB, key: key, iv: nil, d) }
    static func cbcEncryptZeroIV(_ key: Data, _ d: Data) -> Data { crypt(kCCEncrypt, kCCModeCBC, key: key, iv: Data(count: 16), d) }
    static func cbcDecryptZeroIV(_ key: Data, _ d: Data) -> Data { crypt(kCCDecrypt, kCCModeCBC, key: key, iv: Data(count: 16), d) }
    static func ctr(_ key: Data, nonce: Data, _ d: Data) -> Data {
        crypt(kCCEncrypt, kCCModeCTR, key: key, iv: Data(nonce.prefix(8)) + Data(count: 8), d)
    }

    static func pbkdf2SHA512(password: Data, salt: Data, rounds: UInt32 = 100_000) -> Data {
        var out = Data(count: 32)
        let status = password.withUnsafeBytes { p in
            salt.withUnsafeBytes { s in
                out.withUnsafeMutableBytes { o in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), p.bindMemory(to: CChar.self).baseAddress, password.count,
                                         s.bindMemory(to: UInt8.self).baseAddress, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA512),
                                         rounds, o.bindMemory(to: UInt8.self).baseAddress, 32)
                }
            }
        }
        precondition(status == Int32(kCCSuccess), "PBKDF2")
        return out
    }

    static func condensedMac(key: Data, nonce: Data, plaintext: Data) -> Data {
        let n8 = [UInt8](nonce.prefix(8))
        var mac = n8 + n8
        var macs: [[UInt8]] = []
        var p = [UInt8](plaintext)
        p += [UInt8](repeating: 0, count: (16 - p.count % 16) % 16)
        var pos = 0, posNext = 131_072, increment = 131_072
        var i = 0
        while i < p.count {
            for j in 0..<16 { mac[j] ^= p[i + j] }
            mac = [UInt8](ecbEncrypt(key, Data(mac)))
            pos += 16
            if pos >= posNext {
                macs.append(mac)
                mac = n8 + n8
                if increment < 1_048_576 { increment += 131_072 }
                posNext += increment
            }
            i += 16
        }
        macs.append(mac)
        var acc = [UInt8](repeating: 0, count: 16)
        for m in macs {
            for j in 0..<16 { acc[j] ^= m[j] }
            acc = [UInt8](ecbEncrypt(key, Data(acc)))
        }
        return Data([acc[0] ^ acc[4], acc[1] ^ acc[5], acc[2] ^ acc[6], acc[3] ^ acc[7],
                     acc[8] ^ acc[12], acc[9] ^ acc[13], acc[10] ^ acc[14], acc[11] ^ acc[15]])
    }

    static func mergeKeyMac(_ key24: Data, mac: Data) -> Data {
        var k = [UInt8](key24) + [UInt8](mac)
        for i in 0..<16 { k[i] ^= k[16 + i] }
        return Data(k)
    }
    static func unmergeKeyMac(_ key: Data) -> Data {
        var k = [UInt8](key) + [UInt8](repeating: 0, count: max(0, 32 - key.count))
        for i in 0..<16 { k[i] ^= k[16 + i] }
        return Data(k)
    }

    static func encryptAttributes(name: String, key16: Data) -> String {
        var at = [UInt8]("MEGA{\"n\":\"\(name)\"}".utf8)
        at += [UInt8](repeating: 0, count: (16 - at.count % 16) % 16)
        return SyncB64.encode(cbcEncryptZeroIV(key16, Data(at)))
    }
    static func decryptAttributes(_ a: Data, key: Data) -> String? {
        guard !a.isEmpty, a.count % 16 == 0, key.count == 16 || key.count == 32 else { return nil }
        let plain = [UInt8](cbcDecryptZeroIV(Data(unmergeKeyMac(key).prefix(16)), a))
        let text = String(decoding: plain.prefix { $0 != 0 }, as: UTF8.self)
        guard text.hasPrefix("MEGA{\""), let o = (try? JSONSerialization.jsonObject(with: Data(text.dropFirst(4).utf8))) as? [String: Any]
        else { return nil }
        return o["n"] as? String
    }

    static func mpi(_ b: ArraySlice<UInt8>) throws -> (value: Data, rest: ArraySlice<UInt8>) {
        guard b.count >= 2 else { throw MegaClient.Failure.badResponse }
        let bits = Int(b[b.startIndex]) << 8 | Int(b[b.startIndex + 1])
        let len = (bits + 7) / 8
        guard b.count >= 2 + len else { throw MegaClient.Failure.badResponse }
        let start = b.startIndex + 2
        return (Data(b[start..<(start + len)]), b[(start + len)...])
    }

    static func sessionId(csid: Data, privk: Data) throws -> String {
        let (p, r1) = try mpi([UInt8](privk)[...])
        let (q, r2) = try mpi(r1)
        let (d, _) = try mpi(r2)
        let (c, _) = try mpi([UInt8](csid)[...])
        let m = try MegaBigUInt.modPow(MegaBigUInt(c), MegaBigUInt(d), MegaBigUInt(p) * MegaBigUInt(q)).bigEndianBytes
        guard m.count >= 43 else { throw MegaClient.Failure.badResponse }
        return SyncB64.encode(m.prefix(43))
    }

    static func hashcash(_ challenge: String) throws -> String {
        let parts = challenge.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 4, parts[0] == "1", let easiness = Int(parts[1]), (0...255).contains(easiness),
              let token = d64(parts[3]), token.count == 48 else { throw MegaClient.Failure.badResponse }
        let threshold = UInt32(((easiness & 63) << 1) + 1) << UInt32((easiness >> 6) * 7 + 3)
        var buf = [UInt8](repeating: 0, count: 4 + 262_144 * 48)
        let t = [UInt8](token)
        for i in 0..<262_144 { buf.replaceSubrange((4 + i * 48)..<(4 + i * 48 + 48), with: t) }
        while true {
            let h = Array(SHA256.hash(data: buf))
            if (UInt32(h[0]) << 24 | UInt32(h[1]) << 16 | UInt32(h[2]) << 8 | UInt32(h[3])) <= threshold {
                return "1:\(parts[3]):\(SyncB64.encode(Data(buf[0..<4])))"
            }
            var j = 0
            while true { buf[j] &+= 1; if buf[j] != 0 { break }; j += 1 }
        }
    }
}

/// Unsigned big integers for one RSA decryption at login. Not constant-time; only the user's own login.
struct MegaBigUInt: Equatable {
    private(set) var limbs: [UInt32]

    init(limbs: [UInt32]) { self.limbs = limbs; normalize() }
    init(_ bigEndian: Data) {
        let b = [UInt8](bigEndian)
        var l: [UInt32] = []
        var i = b.count
        while i > 0 {
            var w: UInt32 = 0
            for k in 0..<4 where i - 1 - k >= 0 { w |= UInt32(b[i - 1 - k]) << (8 * k) }
            l.append(w)
            i -= 4
        }
        self.init(limbs: l)
    }

    private mutating func normalize() { while limbs.last == 0 { limbs.removeLast() } }

    var bigEndianBytes: Data {
        var out: [UInt8] = []
        for w in limbs.reversed() { out += [UInt8(w >> 24), UInt8(w >> 16 & 0xff), UInt8(w >> 8 & 0xff), UInt8(w & 0xff)] }
        return Data(out.drop { $0 == 0 })
    }
    var bitWidth: Int { limbs.last.map { limbs.count * 32 - $0.leadingZeroBitCount } ?? 0 }
    func bit(_ i: Int) -> Bool { limbs[i / 32] >> UInt32(i % 32) & 1 == 1 }

    static func * (a: MegaBigUInt, b: MegaBigUInt) -> MegaBigUInt {
        guard !a.limbs.isEmpty, !b.limbs.isEmpty else { return MegaBigUInt(limbs: []) }
        var r = [UInt32](repeating: 0, count: a.limbs.count + b.limbs.count)
        for i in 0..<a.limbs.count {
            var c: UInt64 = 0
            for j in 0..<b.limbs.count {
                let s = UInt64(r[i + j]) + UInt64(a.limbs[i]) * UInt64(b.limbs[j]) + c
                r[i + j] = UInt32(truncatingIfNeeded: s)
                c = s >> 32
            }
            r[i + b.limbs.count] = UInt32(c)
        }
        return MegaBigUInt(limbs: r)
    }

    private static func geq(_ a: [UInt32], _ b: [UInt32]) -> Bool {
        var aa = a, bb = b
        while aa.last == 0 { aa.removeLast() }
        while bb.last == 0 { bb.removeLast() }
        if aa.count != bb.count { return aa.count > bb.count }
        for i in stride(from: aa.count - 1, through: 0, by: -1) where aa[i] != bb[i] { return aa[i] > bb[i] }
        return true
    }
    private static func sub(_ a: inout [UInt32], _ b: [UInt32]) {
        var borrow: Int64 = 0
        for i in 0..<a.count {
            let d = Int64(a[i]) - (i < b.count ? Int64(b[i]) : 0) - borrow
            a[i] = UInt32(truncatingIfNeeded: d)
            borrow = d < 0 ? 1 : 0
        }
    }

    func mod(_ m: MegaBigUInt) -> MegaBigUInt {
        guard !m.limbs.isEmpty else { return self }
        let mm = m.limbs
        var r = [UInt32](repeating: 0, count: mm.count + 1)
        for i in stride(from: bitWidth - 1, through: 0, by: -1) {
            var carry: UInt32 = bit(i) ? 1 : 0
            for j in 0..<r.count { let top = r[j] >> 31; r[j] = r[j] << 1 | carry; carry = top }
            if carry != 0 || Self.geq(r, mm) { Self.sub(&r, mm) }
        }
        return MegaBigUInt(limbs: r)
    }

    /// Montgomery (CIOS) modPow for an odd modulus, R = 2^(32·limbCount).
    static func modPow(_ base: MegaBigUInt, _ exp: MegaBigUInt, _ m: MegaBigUInt) throws -> MegaBigUInt {
        let n = m.limbs
        guard !n.isEmpty, n[0] & 1 == 1 else { throw MegaClient.Failure.badResponse } // the modulus comes from MEGA
        let k = n.count
        var inv: UInt32 = 1
        for _ in 0..<5 { inv = inv &* (2 &- n[0] &* inv) }
        let ninv = 0 &- inv
        func pad(_ x: MegaBigUInt) -> [UInt32] { x.limbs + [UInt32](repeating: 0, count: max(0, k - x.limbs.count)) }
        func mont(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
            var t = [UInt32](repeating: 0, count: k + 2)
            for i in 0..<k {
                var c: UInt64 = 0
                for j in 0..<k {
                    let s = UInt64(t[j]) + UInt64(a[i]) * UInt64(b[j]) + c
                    t[j] = UInt32(truncatingIfNeeded: s); c = s >> 32
                }
                var s = UInt64(t[k]) + c
                t[k] = UInt32(truncatingIfNeeded: s); t[k + 1] = UInt32(truncatingIfNeeded: s >> 32)
                let u = UInt64(t[0] &* ninv)
                s = UInt64(t[0]) + u * UInt64(n[0]); c = s >> 32
                for j in 1..<k {
                    s = UInt64(t[j]) + u * UInt64(n[j]) + c
                    t[j - 1] = UInt32(truncatingIfNeeded: s); c = s >> 32
                }
                s = UInt64(t[k]) + c
                t[k - 1] = UInt32(truncatingIfNeeded: s)
                t[k] = t[k + 1] &+ UInt32(truncatingIfNeeded: s >> 32)
                t[k + 1] = 0
            }
            var r = Array(t[0...k])
            if geq(r, n + [0]) { sub(&r, n + [0]) }
            return Array(r[0..<k])
        }
        let r2 = pad(MegaBigUInt(limbs: [UInt32](repeating: 0, count: 2 * k) + [1]).mod(m))
        let one = pad(MegaBigUInt(limbs: [1]))
        let xR = mont(pad(base.mod(m)), r2)
        var acc = mont(one, r2)
        for i in stride(from: exp.bitWidth - 1, through: 0, by: -1) {
            acc = mont(acc, acc)
            if exp.bit(i) { acc = mont(acc, xR) }
        }
        return MegaBigUInt(limbs: mont(acc, one))
    }

}


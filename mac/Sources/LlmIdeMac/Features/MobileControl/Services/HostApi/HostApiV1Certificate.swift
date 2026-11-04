import Foundation
import CryptoKit

/// Self-signed X.509 v3 server certificate for the Host API v1 TLS listener, hand-built DER (no ASN.1
/// dependency). The client pins the SPKI hash, so names and the CA chain carry no trust; the fields are
/// the minimum a TLS stack accepts. Mirrored byte-for-byte in structure by extension/server/host-identity.mjs.
enum HostApiV1Certificate {
    static func tlv(_ tag: UInt8, _ body: Data) -> Data {
        var out = Data([tag])
        if body.count < 0x80 { out.append(UInt8(body.count)) } else {
            var n = body.count; var len: [UInt8] = []
            while n > 0 { len.insert(UInt8(n & 0xFF), at: 0); n >>= 8 }
            out.append(0x80 | UInt8(len.count)); out.append(contentsOf: len)
        }
        return out + body
    }
    static func seq(_ parts: Data...) -> Data { tlv(0x30, parts.reduce(Data(), +)) }
    static func oid(_ bytes: [UInt8]) -> Data { tlv(0x06, Data(bytes)) }
    static func int(_ raw: Data) -> Data {
        var b = [UInt8](raw)
        while b.count > 1, b[0] == 0, b[1] & 0x80 == 0 { b.removeFirst() }
        if let f = b.first, f & 0x80 != 0 { b.insert(0, at: 0) }
        return tlv(0x02, Data(b))
    }
    static func utcTime(_ date: Date) -> Data {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyMMddHHmmss'Z'"
        return tlv(0x17, Data(f.string(from: date).utf8))
    }

    static let ecdsaWithSHA256: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]

    static func selfSigned(key: P256.Signing.PrivateKey, commonName: String, notBefore: Date, notAfter: Date, serial: Data) throws -> Data {
        // UTCTime covers years < 2050; a 5-year certificate minted before 2045 never needs GeneralizedTime.
        precondition(Calendar(identifier: .gregorian).component(.year, from: notAfter) < 2050)
        let name = seq(tlv(0x31, seq(oid([0x55, 0x04, 0x03]), tlv(0x0C, Data(commonName.utf8)))))
        let alg = seq(oid(ecdsaWithSHA256))
        let extensions = tlv(0xA3, seq(
            seq(oid([0x55, 0x1D, 0x13]), tlv(0x01, Data([0xFF])), tlv(0x04, seq())),                          // basicConstraints CA:FALSE, critical
            seq(oid([0x55, 0x1D, 0x0F]), tlv(0x01, Data([0xFF])), tlv(0x04, tlv(0x03, Data([0x07, 0x80])))),  // keyUsage digitalSignature, critical
            seq(oid([0x55, 0x1D, 0x25]), tlv(0x04, seq(oid([0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01]))))  // extKeyUsage serverAuth
        ))
        let tbs = seq(tlv(0xA0, int(Data([2]))), int(serial), alg, name,
                      seq(utcTime(notBefore), utcTime(notAfter)), name, key.publicKey.derRepresentation, extensions)
        let signature = try key.signature(for: tbs).derRepresentation
        return seq(tbs, alg, tlv(0x03, Data([0]) + signature))
    }
}

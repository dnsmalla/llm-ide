import Testing
import Foundation
import CryptoKit
import Security
@testable import LlmIdeMacLib

@Suite("HostApiV1Identity")
struct HostApiV1IdentityTests {
    static let vector: [String: String] = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../schema/host-api/v1/fixtures/security/identity-vector.json").standardized
        return (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: String] ?? [:]
    }()
    static func b64url(_ s: String) -> Data {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)!
    }

    @Test("the fingerprint matches the shared Node/openssl vector")
    func vectorFingerprint() throws {
        let d = try #require(Self.vector["d"], "identity-vector.json not found")
        let key = try P256.Signing.PrivateKey(rawRepresentation: Self.b64url(d))
        #expect(key.publicKey.derRepresentation.base64EncodedString() == Self.vector["spkiDerBase64"])
        #expect(HostApiV1Identity.fingerprint(spkiDER: key.publicKey.derRepresentation) == Self.vector["fingerprint"])
    }

    @Test("the certificate parses, carries the key, and verifies its own signature")
    func certificateParses() throws {
        let key = P256.Signing.PrivateKey()
        let der = try HostApiV1Certificate.selfSigned(key: key, commonName: "LLM-IDE Test", notBefore: Date(timeIntervalSince1970: 1_760_000_000),
                                                       notAfter: Date(timeIntervalSince1970: 1_760_000_000 + HostApiV1Identity.validity), serial: Data(repeating: 0x7F, count: 16))
        let cert = try #require(SecCertificateCreateWithData(nil, der as CFData))
        #expect(HostApiV1Identity.fingerprint(certificate: cert) == HostApiV1Identity.fingerprint(spkiDER: key.publicKey.derRepresentation))
        #expect((SecCertificateCopySubjectSummary(cert) as String?) == "LLM-IDE Test")
        // Self-signature: the TBS (first element of the outer SEQUENCE) verifies under the public key.
        let (tbs, sig) = try #require(HostApiV1CertificateTestDER.split(der))
        #expect(key.publicKey.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: sig), for: tbs))
    }

    @Test("load-or-create persists one identity; reset makes a new one; a read failure never regenerates")
    func persistence() throws {
        let backend = InMemoryKeychainAccess()
        let a = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: backend)
        let b = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: backend)
        #expect(a.created && !b.created)
        #expect(a.fingerprint == b.fingerprint)
        #expect(a.fingerprint.hasPrefix("sha256:") && a.fingerprint.count == 7 + 43)
        HostApiV1Identity.reset(backend: backend)
        #expect(try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: backend).fingerprint != a.fingerprint)
        let locked = FailingKeychain(status: errSecInteractionNotAllowed)
        #expect(throws: HostApiV1Identity.Failure.keychain(errSecInteractionNotAllowed)) { try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: locked) }
        #expect(locked.writes == 0)
        let corrupt = InMemoryKeychainAccess()
        _ = corrupt.write(account: HostApiV1Identity.account, service: "com.llmide.macapp", data: Data("junk".utf8))
        #expect(throws: HostApiV1Identity.Failure.corrupt) { try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: corrupt) }
    }

    /// Same field names as HostApiV1Identity's private `Material`.
    struct StoredMaterial: Codable { let key: Data; let cert: Data; let notAfter: Date }

    @Test("a well-formed stored identity whose certificate is for another key is corrupt")
    func mismatchedCertificate() throws {
        let key = P256.Signing.PrivateKey(), other = P256.Signing.PrivateKey()
        let notAfter = Date(timeIntervalSince1970: 1_900_000_000)
        let cert = try HostApiV1Certificate.selfSigned(key: other, commonName: "LLM-IDE Mac", notBefore: Date(timeIntervalSince1970: 1_760_000_000),
                                                        notAfter: notAfter, serial: Data([0x01]))
        let backend = InMemoryKeychainAccess()
        _ = backend.write(account: HostApiV1Identity.account, service: "com.llmide.macapp",
                          data: try JSONEncoder().encode(StoredMaterial(key: key.rawRepresentation, cert: cert, notAfter: notAfter)))
        #expect(throws: HostApiV1Identity.Failure.corrupt) { try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: backend) }
    }

    @Test("dates from 2050 are GeneralizedTime, earlier ones UTCTime, and the certificate still parses")
    func generalizedTimeFrom2050() throws {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = try #require(TimeZone(identifier: "UTC"))
        let notBefore = try #require(cal.date(from: DateComponents(year: 2049, month: 6, day: 1)))
        let notAfter = try #require(cal.date(from: DateComponents(year: 2051, month: 1, day: 1)))
        let der = try HostApiV1Certificate.selfSigned(key: P256.Signing.PrivateKey(), commonName: "LLM-IDE Test",
                                                       notBefore: notBefore, notAfter: notAfter, serial: Data([0x01]))
        #expect(SecCertificateCreateWithData(nil, der as CFData) != nil)
        let validity = HostApiV1Certificate.seq(Data([0x17, 13]) + Data("490601000000Z".utf8),
                                                Data([0x18, 15]) + Data("20510101000000Z".utf8))
        #expect(der.range(of: validity) != nil)
    }
}

/// Outer SEQUENCE → (tbs TLV bytes, signature DER without the BIT STRING's unused-bits byte).
enum HostApiV1CertificateTestDER {
    /// One TLV at `i`: returns (header length, body length) — short form, 0x81 and 0x82 only.
    static func header(_ b: [UInt8], _ i: Int) -> (Int, Int)? {
        guard i + 1 < b.count else { return nil }
        let l = b[i + 1]
        if l < 0x80 { return (2, Int(l)) }
        if l == 0x81, i + 2 < b.count { return (3, Int(b[i + 2])) }
        if l == 0x82, i + 3 < b.count { return (4, Int(b[i + 2]) << 8 | Int(b[i + 3])) }
        return nil
    }
    static func split(_ der: Data) -> (Data, Data)? {
        let b = [UInt8](der)
        guard b.first == 0x30, let (oh, _) = header(b, 0) else { return nil }
        var i = oh, parts: [ArraySlice<UInt8>] = []
        for _ in 0..<3 {
            guard let (h, n) = header(b, i), i + h + n <= b.count else { return nil }
            parts.append(b[i..<(i + h + n)]); i += h + n
        }
        let bits = parts[2]
        guard bits.first == 0x03, let (bh, _) = header(Array(bits), 0) else { return nil }
        return (Data(parts[0]), Data(bits.dropFirst(bh + 1)))
    }
}

final class FailingKeychain: RawKeychainAccess, @unchecked Sendable {
    let status: OSStatus; private(set) var writes = 0
    init(status: OSStatus) { self.status = status }
    func read(account: String, service: String) -> KeychainRawRead { .failed(status) }
    func write(account: String, service: String, data: Data) -> Bool { writes += 1; return false }
    func delete(account: String, service: String) {}
    func deleteAll(service: String) -> OSStatus { errSecSuccess }
}

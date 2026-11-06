import Testing
import Foundation
import Security
import SharedProtocol

/// A socket whose TLS handshake was refused by the pin: every call throws the pin rejection.
private final class PinRefusedSocket: HostApiSocket, @unchecked Sendable {
    func send(_ text: String) async throws { throw HostApiPinning.mismatch }
    func receive() async throws -> Data { throw HostApiPinning.mismatch }
    func cancel() {}
}

@Suite("HostApiPinning")
struct HostApiPinningTests {
    struct Vector: Decodable { let x: String; let y: String; let spkiDerBase64: String; let fingerprint: String }
    static func vector() throws -> Vector {
        try JSONDecoder().decode(Vector.self, from: HostApiFixtures.data("fixtures/security/identity-vector.json"))
    }
    static func base64url(_ s: String) -> Data {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)!
    }
    /// Self-signed certificate over the vector key (TEST ONLY; generated with openssl from identity-vector.json).
    static let vectorCertDER = Data(base64Encoded: "MIIBkjCCATegAwIBAgIUQUs+bZVlnYuoabXUmXhHqML7JIowCgYIKoZIzj0EAwIwHTEbMBkGA1UEAwwSbGxtaWRlIHRlc3QgdmVjdG9yMCAXDTI2MTEwNDA3NTMwM1oYDzIxMjYxMDExMDc1MzAzWjAdMRswGQYDVQQDDBJsbG1pZGUgdGVzdCB2ZWN0b3IwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARhNXvIwGlikxYAjPlvyfGS8xyaRoV7JA35hSbmrzYwv4aB9x+eCGcFjNxx+KcERit3XZRFO07dft+zlQBojig2o1MwUTAdBgNVHQ4EFgQUSt/PqRpS7d7909FHoeoN16fQl0kwHwYDVR0jBBgwFoAUSt/PqRpS7d7909FHoeoN16fQl0kwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAml78sSrnFg8gIUzaZqhGXSKhfTRYp0gkK2f7RQjewu0CIQDxA2Wusq21kf4KqLi+qD/Pd/e1qJF3Uq/8YFSx9UW9Cw==")!

    @Test("the Plan 6 vector: SPKI DER hashes to the fingerprint, and the raw P-256 point rebuilds that SPKI")
    func vectorReproduces() throws {
        let v = try Self.vector()
        let spki = Data(base64Encoded: v.spkiDerBase64)!
        #expect(HostApiPinning.fingerprint(spkiDER: spki) == v.fingerprint)
        let point = Data([0x04]) + Self.base64url(v.x) + Self.base64url(v.y)
        #expect(HostApiPinning.spkiDER(p256X963: point) == spki)
        #expect(HostApiPinning.spkiDER(p256X963: point.dropLast()) == nil)
        #expect(HostApiPinning.spkiDER(p256X963: Data([0x02]) + point.dropFirst()) == nil, "compressed/other forms refused")
        #expect(HostApiPinning.isValidFingerprint(v.fingerprint))
    }

    @Test("a certificate's fingerprint is its SPKI's, read through Security.framework")
    func certificateFingerprint() throws {
        let cert = try #require(SecCertificateCreateWithData(nil, Self.vectorCertDER as CFData))
        #expect(HostApiPinning.fingerprint(certificate: cert) == (try Self.vector()).fingerprint)
    }

    @Test("pinned trust: the paired leaf passes, any other pin or no pin is refused")
    func pinnedTrust() throws {
        let v = try Self.vector()
        let cert = try #require(SecCertificateCreateWithData(nil, Self.vectorCertDER as CFData))
        var trust: SecTrust?
        #expect(SecTrustCreateWithCertificates(cert, SecPolicyCreateBasicX509(), &trust) == errSecSuccess)
        let serverTrust = try #require(trust)
        #expect(HostApiPinnedTrust(pin: v.fingerprint).evaluate(serverTrust, host: "192.168.1.5"))
        #expect(!HostApiPinnedTrust(pin: "sha256:" + String(repeating: "A", count: 43)).evaluate(serverTrust, host: "192.168.1.5"))
        #expect(!HostApiPinnedTrust(pin: "").evaluate(serverTrust, host: "192.168.1.5"))
    }

    @Test("pin decision: match accepts, mismatch and a missing side reject")
    func decision() throws {
        let fp = try Self.vector().fingerprint
        #expect(HostApiPinning.matches(fp, pin: fp))
        #expect(!HostApiPinning.matches(fp, pin: "sha256:" + String(repeating: "A", count: 43)))
        #expect(!HostApiPinning.matches(fp, pin: String(fp.dropLast())))
        #expect(!HostApiPinning.matches(fp, pin: nil))
        #expect(!HostApiPinning.matches(nil, pin: fp))
        #expect(!HostApiPinning.matches("", pin: ""))
    }

    @Test("fingerprint format: sha256: + 43 base64url characters, nothing else")
    func format() throws {
        let fp = try Self.vector().fingerprint
        #expect(!HostApiPinning.isValidFingerprint(String(fp.dropLast())))
        #expect(!HostApiPinning.isValidFingerprint(fp + "="))
        #expect(!HostApiPinning.isValidFingerprint("sha1:" + fp.dropFirst(7)))
        #expect(!HostApiPinning.isValidFingerprint("sha256:" + String(repeating: "+", count: 43)))
    }

    @Test("pinning is QR-only: only a QR scan sets or replaces the pin")
    func explicitPairingOnly() throws {
        let fp = try Self.vector().fingerprint
        let other = "sha256:" + String(repeating: "C", count: 43)
        func pin(_ stored: String?, _ offered: String?, _ source: HostApiPairingSource, sameHost: Bool = true) -> String? {
            HostApiPinning.pinAfterOffer(stored: stored, offered: offered, source: source, sameHost: sameHost)
        }
        #expect(pin(fp, other, .qrScan) == other, "a QR scan replaces the pin")
        #expect(pin(nil, other, .qrScan) == other, "a QR scan creates one")
        #expect(pin(fp, nil, .qrScan) == nil, "a QR without h1fp drops the old pin")
        #expect(pin(fp, "junk", .qrScan) == nil)
        #expect(pin(nil, other, .typedPin) == nil, "a typed PIN never adopts an offered h1fp")
        #expect(pin(fp, other, .typedPin) == fp, "a typed PIN to the same host keeps the pin (final M5)")
        #expect(pin(fp, nil, .typedPin) == fp, "manual entry carries no offer and keeps the pin")
        #expect(pin(fp, nil, .typedPin, sameHost: false) == nil, "a pin is never carried to another host")
    }

    @Test("pairing offer: h1port + h1fp parsed and validated")
    func offer() throws {
        let fp = try Self.vector().fingerprint
        #expect(HostApiPairingOffer(port: "3016", fingerprint: fp) == HostApiPairingOffer(port: 3016, fingerprint: fp))
        #expect(HostApiPairingOffer(port: "80", fingerprint: fp) == nil)
        #expect(HostApiPairingOffer(port: "3016", fingerprint: "nope") == nil)
        #expect(HostApiPairingOffer(port: nil, fingerprint: fp) == nil)
        #expect(HostApiPairingOffer(port: "3016", fingerprint: nil) == nil)
        #expect(HostApiPairingOffer(port: 3016, fingerprint: fp).endpoint(host: "192.168.1.5")?.url.absoluteString
                == "wss://192.168.1.5:3016/host-api/v1")
        #expect(HostApiPairingOffer(port: 3016, fingerprint: fp).endpoint(host: "fe80::1")?.url.absoluteString
                == "wss://[fe80::1]:3016/host-api/v1")
    }

    @Test("endpoint: wss to any host on the v1 path; ws only to loopback")
    func endpoint() {
        let e = HostApiEndpoint("wss://192.168.1.5:3017/host-api/v1")
        #expect(e?.url.absoluteString == "wss://192.168.1.5:3017/host-api/v1")
        #expect(e?.isTLS == true)
        #expect(HostApiEndpoint("ws://127.0.0.1:3016")?.isTLS == false)
        #expect(HostApiEndpoint("wss://192.168.1.5:3017/other") == nil)
        #expect(HostApiEndpoint("wss://192.168.1.5:3017/host-api/v1?x") == nil)
        #expect(HostApiEndpoint("wss://192.168.1.5:3017/host-api/v1#f") == nil)
        #expect(HostApiEndpoint("wss://u:p@192.168.1.5:3017/host-api/v1") == nil)
        #expect(HostApiEndpoint("wss://192.168.1.5/host-api/v1") == nil, "the port is never assumed")
        #expect(HostApiEndpoint("ws://192.168.1.5:3016") == nil)
    }

    @Test("wss needs a pin before any socket opens; ws to loopback does not")
    func trustForEndpoint() throws {
        let fp = try Self.vector().fingerprint
        let wss = try #require(HostApiEndpoint("wss://192.168.1.5:3017"))
        let ws = try #require(HostApiEndpoint("ws://127.0.0.1:3016"))
        #expect(throws: HostApiPinning.missingPin) { try HostApiPinning.trust(for: wss, pin: nil) }
        #expect(throws: HostApiPinning.missingPin) { try HostApiPinning.trust(for: wss, pin: "junk") }
        #expect(try HostApiPinning.trust(for: wss, pin: fp) != nil)
        #expect(try HostApiPinning.trust(for: ws, pin: nil) == nil)
    }

    @Test("a pin mismatch is a hard refusal, never 'not v1', and never clears credentials")
    @MainActor
    func mismatchIsRefusal() async {
        let c = HostApiV1Client(config: .init(clientName: "iPhone", clientVersion: "2", helloTimeout: 0.5),
                                makeSocket: { PinRefusedSocket() })
        #expect(await c.connect(.token("t")) == .refused(HostApiPinning.mismatch))
        #expect(!HostApiPinning.mismatch.retryable)
        #expect(HostApiPinning.mismatch.code != "host_unreachable")
        #expect(!HostApiNegotiation.clearsCredentials(HostApiPinning.mismatch))
    }
}

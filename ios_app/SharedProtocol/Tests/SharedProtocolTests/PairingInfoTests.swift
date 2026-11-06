import Testing
import Foundation
@testable import SharedProtocol

@Suite("PairingInfo: the desktop's Host API pairing QR payload")
struct PairingInfoTests {
    private static let fp = "sha256:" + String(repeating: "A", count: 43)
    private func qr(_ ip: String, pin: String = "123456", h1port: String = "3016", fp: String = Self.fp) -> String {
        "llmide://pair?ip=\(ip)&pin=\(pin)&h1port=\(h1port)&h1fp=\(fp)&api=1"
    }

    @Test("a valid payload parses to its host, pin and v1 offer")
    func roundTrip() throws {
        let p = try #require(PairingInfo(from: qr("192.168.1.20")))
        #expect(p.ip == "192.168.1.20" && p.pin == "123456")
        #expect(p.hostApiOffer == HostApiPairingOffer(port: 3016, fingerprint: Self.fp))
    }

    @Test("a QR without a usable v1 offer (no h1port/h1fp, a bad port or fingerprint) is refused")
    func needsOffer() {
        #expect(PairingInfo(from: "llmide://pair?ip=192.168.1.20&port=3006&pin=123456") == nil)
        #expect(PairingInfo(from: qr("192.168.1.20", h1port: "abc")) == nil)
        #expect(PairingInfo(from: qr("192.168.1.20", h1port: "80")) == nil)
        #expect(PairingInfo(from: qr("192.168.1.20", fp: "sha256:short")) == nil)
    }

    @Test("an IPv6 zone id is kept; a %-suffix on an IPv4 host is rejected")
    func zoneIds() throws {
        let p = try #require(PairingInfo(from: qr("fe80::1%25en0")))
        #expect(p.ip == "fe80::1%en0")
        #expect(PairingInfo(from: qr("192.168.1.1%25evil.com")) == nil)
    }

    @Test("a public address or DNS name is refused")
    func publicHost() {
        #expect(PairingInfo(from: qr("8.8.8.8")) == nil)
        #expect(PairingInfo(from: qr("example.com")) == nil)
    }

    @Test("only real fc00::/7 and fe80::/10 addresses count as private IPv6")
    func ipv6Ranges() {
        #expect(PairingInfo(from: qr("fd12::1")) != nil)
        #expect(PairingInfo(from: qr("fe80::1")) != nil)
        #expect(PairingInfo(from: qr("fc::1")) == nil)
        #expect(PairingInfo(from: qr("fe8::1")) == nil)
        #expect(PairingInfo(from: qr("2001:db8::1")) == nil)
    }

    @Test("a wrong scheme, a bad PIN or an oversized host is refused")
    func malformed() {
        #expect(PairingInfo(from: qr("192.168.1.20").replacingOccurrences(of: "llmide://", with: "https://")) == nil)
        #expect(PairingInfo(from: qr("192.168.1.20", pin: "12a456")) == nil)
        #expect(PairingInfo(from: qr("\(String(repeating: "a", count: 300)).local")) == nil)
    }
}

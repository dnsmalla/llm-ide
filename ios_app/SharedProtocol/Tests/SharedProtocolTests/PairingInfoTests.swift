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

    @Test("a public hub name is accepted only when the QR carries its certificate pin")
    func publicHost() throws {
        let p = try #require(PairingInfo(from: qr("hub.example.com")))
        #expect(p.ip == "hub.example.com")
        #expect(p.hostApiOffer.fingerprint == Self.fp)
        #expect(PairingInfo(from: qr("8.8.8.8")) == nil, "a public IP literal is never a hub name")
        #expect(PairingInfo(from: "llmide://pair?ip=hub.example.com&pin=123456&h1port=443&api=1") == nil,
                "without h1fp the public name is refused")
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

    private func multi(_ ips: [String]) -> String {
        "llmide://pair?" + ips.map { "ip=\($0)&" }.joined() + "pin=123456&h1port=3016&h1fp=\(Self.fp)&api=1"
    }

    @Test("repeated ip items are all kept in QR order; ip is the first")
    func multiIp() throws {
        let p = try #require(PairingInfo(from: multi(["100.64.0.5", "192.168.1.20", "10.0.0.7"])))
        #expect(p.addresses == ["100.64.0.5", "192.168.1.20", "10.0.0.7"])
        #expect(p.ip == "100.64.0.5")
    }

    @Test("invalid addresses are dropped; the QR is refused only when none is valid")
    func mixedValidity() throws {
        let p = try #require(PairingInfo(from: multi(["8.8.8.8", "192.168.1.20", "192.168.1.1%25evil.com", "10.0.0.7"])))
        #expect(p.addresses == ["192.168.1.20", "10.0.0.7"])
        #expect(p.ip == "192.168.1.20")
        #expect(PairingInfo(from: multi(["8.8.8.8", "1.1.1.1"])) == nil)
    }

    @Test("duplicates collapse, keeping the first position")
    func dedupe() throws {
        let p = try #require(PairingInfo(from: multi(["192.168.1.20", "10.0.0.7", "192.168.1.20"])))
        #expect(p.addresses == ["192.168.1.20", "10.0.0.7"])
    }

    @Test("at most four addresses are kept")
    func cap() throws {
        let p = try #require(PairingInfo(from: multi(["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"])))
        #expect(p.addresses == ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"])
    }

    @Test("an old single-ip QR yields a one-element list")
    func singleIp() throws {
        let p = try #require(PairingInfo(from: qr("192.168.1.20")))
        #expect(p.addresses == ["192.168.1.20"] && p.ip == "192.168.1.20")
    }

    @Test("the legacy aicontrol scheme is no longer accepted")
    func legacySchemeRefused() {
        #expect(PairingInfo(from: qr("192.168.1.20").replacingOccurrences(of: "llmide://", with: "aicontrol://")) == nil)
    }
}

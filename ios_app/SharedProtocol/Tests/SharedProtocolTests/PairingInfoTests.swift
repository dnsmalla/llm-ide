import Testing
import Foundation
@testable import SharedProtocol

@Suite("PairingInfo: the Mac's pairing QR payload")
struct PairingInfoTests {
    @Test("a valid payload parses to its host, port and pin; an absent port means the default")
    func roundTrip() throws {
        let p = try #require(PairingInfo(from: "llmide://pair?ip=192.168.1.20&port=3007&pin=123456"))
        #expect(p.ip == "192.168.1.20" && p.port == 3007 && p.pin == "123456")
        #expect(PairingInfo(from: "llmide://pair?ip=192.168.1.20&pin=123456")?.port == PairingInfo.defaultPort)
    }

    @Test("a present but non-integer port is rejected, not replaced by the default")
    func badPort() {
        #expect(PairingInfo(from: "llmide://pair?ip=192.168.1.20&port=abc&pin=123456") == nil)
    }

    @Test("an IPv6 zone id is kept; a %-suffix on an IPv4 host is rejected")
    func zoneIds() throws {
        let p = try #require(PairingInfo(from: "llmide://pair?ip=fe80::1%25en0&port=3006&pin=123456"))
        #expect(p.ip == "fe80::1%en0")
        #expect(PairingInfo(from: "llmide://pair?ip=192.168.1.1%25evil.com&port=3006&pin=123456") == nil)
    }

    @Test("a public address or DNS name is refused")
    func publicHost() {
        #expect(PairingInfo(from: "llmide://pair?ip=8.8.8.8&port=3006&pin=123456") == nil)
        #expect(PairingInfo(from: "llmide://pair?ip=example.com&port=3006&pin=123456") == nil)
    }

    @Test("only real fc00::/7 and fe80::/10 addresses count as private IPv6")
    func ipv6Ranges() {
        #expect(PairingInfo(from: "llmide://pair?ip=fd12::1&port=3006&pin=123456") != nil)
        #expect(PairingInfo(from: "llmide://pair?ip=fe80::1&port=3006&pin=123456") != nil)
        #expect(PairingInfo(from: "llmide://pair?ip=fc::1&port=3006&pin=123456") == nil)
        #expect(PairingInfo(from: "llmide://pair?ip=fe8::1&port=3006&pin=123456") == nil)
        #expect(PairingInfo(from: "llmide://pair?ip=2001:db8::1&port=3006&pin=123456") == nil)
    }

    @Test("a wrong scheme, a bad PIN, a privileged port or an oversized host is refused")
    func malformed() {
        #expect(PairingInfo(from: "https://pair?ip=192.168.1.20&port=3006&pin=123456") == nil)
        #expect(PairingInfo(from: "llmide://pair?ip=192.168.1.20&port=3006&pin=12a456") == nil)
        #expect(PairingInfo(from: "llmide://pair?ip=192.168.1.20&port=80&pin=123456") == nil)
        #expect(PairingInfo(from: "llmide://pair?ip=\(String(repeating: "a", count: 300)).local&port=3006&pin=123456") == nil)
    }
}

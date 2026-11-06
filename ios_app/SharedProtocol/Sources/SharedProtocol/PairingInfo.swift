import Foundation

/// Result of scanning the Mac app's pairing QR code
/// (`llmide://pair?ip=…&port=…&pin=…`; also accepts the legacy `aicontrol://`).
///
/// Every field is VALIDATED before it is accepted. A scanned code — or any app
/// invoking the `llmide://` scheme — silently re-points this phone at whatever
/// host it names, and the receiving server can then push fabricated chat
/// replies, session lists, and status frames while harvesting whatever the user
/// types next. So the host must be a literal address on a local/private network
/// (or an mDNS `.local` name), the PIN must have the exact shape `MobilePin`
/// mints, and the port must be a real high port. Anything else is not a pairing
/// code we are willing to act on.
public struct PairingInfo {
    public let ip: String
    public let port: Int
    public let pin: String
    /// The host's v1 TLS listener and certificate pin (`h1port` + `h1fp`); nil while it serves only v2.
    public let hostApiOffer: HostApiPairingOffer?

    public static let defaultPort = 3006

    public init?(from string: String) {
        guard let components = URLComponents(string: string),
              ["llmide", "aicontrol"].contains(components.scheme),
              let items = components.queryItems,
              let host = items.first(where: { $0.name == "ip" })?.value,
              let pin = items.first(where: { $0.name == "pin" })?.value
        else { return nil }
        // An absent port means the default; a present one must be an integer, never silently replaced.
        let port: Int
        if let item = items.first(where: { $0.name == "port" }) {
            guard let p = item.value.flatMap(Int.init) else { return nil }
            port = p
        } else {
            port = Self.defaultPort
        }
        guard let canonicalHost = Self.canonicalPrivateHost(host),
              Self.isWellFormedPin(pin), Self.isUsablePort(port)
        else { return nil }
        // Store the VALIDATED string, not the raw one: validating `bare` while
        // persisting `host` is a parser differential — `192.168.1.1%25evil.com`
        // validated as `192.168.1.1` and was saved with the suffix attached.
        self.ip = canonicalHost
        self.pin = pin
        self.port = port
        self.hostApiOffer = HostApiPairingOffer(port: items.first(where: { $0.name == "h1port" })?.value,
                                                fingerprint: items.first(where: { $0.name == "h1fp" })?.value)
    }

    /// Exactly six ASCII digits — the shape `MobilePin.regenerate` produces.
    /// Also stops a junk value from reaching the pairing frame at all.
    public static func isWellFormedPin(_ pin: String) -> Bool {
        pin.count == 6 && pin.allSatisfy { $0.isASCII && $0.isNumber }
    }

    static func isUsablePort(_ port: Int) -> Bool {
        (1024...65_535).contains(port)
    }

    /// A host this app is willing to be re-pointed at: a literal IPv4 in a
    /// private/link-local/loopback range, Tailscale's CGNAT range (the Mac
    /// PREFERS that address in the QR — see `MobileConnectionInfo`), a
    /// link-local/ULA IPv6, or an mDNS `.local` name. Public addresses and
    /// arbitrary DNS names are refused, as is anything carrying URL syntax
    /// (`/`, `?`, `@`, …) that would rewrite the WebSocket URL's path or query.
    public static func isPrivateHost(_ host: String) -> Bool {
        canonicalPrivateHost(host) != nil
    }

    /// The accepted host, exactly as it should be stored and dialled, or nil
    /// when it isn't one we're willing to be re-pointed at. A zone id is kept
    /// ONLY for an IPv6 literal (`fe80::1%en0`), where it is meaningful.
    static func canonicalPrivateHost(_ host: String) -> String? {
        guard !host.isEmpty, host.count <= 255 else { return nil }

        if host.contains(":") {
            let parts = host.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: false)
            let addr = String(parts[0])
            guard isPrivateIPv6(addr) else { return nil }
            guard parts.count == 2 else { return addr }
            let zone = String(parts[1])
            guard !zone.isEmpty, zone.count <= 15,
                  zone.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
            return "\(addr)%\(zone)"
        }
        // Anything else must be exactly what it claims to be — no zone ids, no
        // trailing URL syntax.
        guard !host.contains("%") else { return nil }

        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        if octets.count == 4, octets.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) {
            let values = octets.compactMap { Int($0) }
            guard values.count == 4, values.allSatisfy({ (0...255).contains($0) }) else { return nil }
            return isPrivateIPv4(values) ? host : nil
        }
        // Not an IP literal — only mDNS / Tailscale MagicDNS names qualify.
        return isPrivateName(host) ? host : nil
    }

    private static func isPrivateIPv4(_ o: [Int]) -> Bool {
        switch (o[0], o[1]) {
        case (10, _):                       return true   // 10.0.0.0/8
        case (127, _):                      return true   // loopback / simulator
        case (169, 254):                    return true   // link-local
        case (172, 16...31):                return true   // 172.16.0.0/12
        case (192, 168):                    return true   // 192.168.0.0/16
        case (100, 64...127):               return true   // 100.64.0.0/10 — Tailscale CGNAT
        default:                            return false
        }
    }

    private static func isPrivateIPv6(_ addr: String) -> Bool {
        let lower = addr.lowercased()
        guard lower.allSatisfy({ $0.isHexDigit || $0 == ":" }) else { return false }
        if lower == "::1" { return true }                       // loopback
        if lower.hasPrefix("fe8") || lower.hasPrefix("fe9")
            || lower.hasPrefix("fea") || lower.hasPrefix("feb") { return true }  // fe80::/10
        if lower.hasPrefix("fc") || lower.hasPrefix("fd") { return true }        // fc00::/7 ULA
        return false
    }

    /// mDNS (`*.local`) or Tailscale MagicDNS (`*.ts.net`) — both name a host
    /// reachable only on the user's own local network / tailnet.
    private static func isPrivateName(_ name: String) -> Bool {
        let lower = name.lowercased()
        guard lower.hasSuffix(".local") || lower.hasSuffix(".ts.net") else { return false }
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return false }
        return labels.allSatisfy { label in
            !label.isEmpty && label.count <= 63
                && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
    }
}

import Foundation

/// Result of scanning the desktop's Host API pairing QR code (Settings → Host API pairing:
/// `llmide://pair?ip=…&pin=…&h1port=…&h1fp=…&api=1`; also accepts the legacy `aicontrol://` scheme).
/// A sync enrollment QR shares the scheme; its fields are ignored here (`SyncEnroll.parsePair` reads them).
///
/// Every field is VALIDATED before it is accepted. A scanned code — or any app
/// invoking the `llmide://` scheme — re-points this phone at whatever host it
/// names. So the host must be a literal address on a local/private network
/// (or an mDNS / Tailscale name), the PIN must have the exact shape the host
/// mints, and the v1 listener must come with a well-formed certificate pin.
/// Anything else is not a pairing code we are willing to act on.
public struct PairingInfo {
    public let ip: String
    public let pin: String
    /// The host's v1 TLS listener and certificate pin (`h1port` + `h1fp`). Required: the phone pins from a QR only.
    public let hostApiOffer: HostApiPairingOffer

    public init?(from string: String) {
        guard let components = URLComponents(string: string),
              ["llmide", "aicontrol"].contains(components.scheme),
              let items = components.queryItems,
              let host = items.first(where: { $0.name == "ip" })?.value,
              let pin = items.first(where: { $0.name == "pin" })?.value,
              let offer = HostApiPairingOffer(port: items.first(where: { $0.name == "h1port" })?.value,
                                              fingerprint: items.first(where: { $0.name == "h1fp" })?.value),
              let canonicalHost = Self.canonicalHost(host, allowPublicWithPin: offer.fingerprint), Self.isWellFormedPin(pin)
        else { return nil }
        // Store the VALIDATED string, not the raw one: validating `bare` while
        // persisting `host` is a parser differential — `192.168.1.1%25evil.com`
        // validated as `192.168.1.1` and was saved with the suffix attached.
        self.ip = canonicalHost
        self.pin = pin
        self.hostApiOffer = offer
    }

    /// Exactly six ASCII digits — the shape the host's pairing PIN has.
    /// Also stops a junk value from reaching the pairing frame at all.
    public static func isWellFormedPin(_ pin: String) -> Bool {
        pin.count == 6 && pin.allSatisfy { $0.isASCII && $0.isNumber }
    }

    /// A host this app is willing to be re-pointed at: a literal IPv4 in a
    /// private/link-local/loopback range, Tailscale's CGNAT range (the desktop
    /// lists that address first in the QR), a
    /// link-local/ULA IPv6, or an mDNS `.local` name. Public addresses and
    /// arbitrary DNS names are refused, as is anything carrying URL syntax
    /// (`/`, `?`, `@`, …) that would rewrite the endpoint URL's path or query.
    public static func isPrivateHost(_ host: String) -> Bool {
        canonicalPrivateHost(host) != nil
    }

    /// A scanned QR may name a public hub only when it also carries a certificate pin (`h1fp`): the
    /// optical channel is then the trust anchor, exactly as it is for a private host. A typed PIN never
    /// arrives here (its screen keeps the old pin), so a public name cannot be adopted without a QR.
    static func canonicalHost(_ host: String, allowPublicWithPin pin: String?) -> String? {
        if let privateHost = canonicalPrivateHost(host) { return privateHost }
        guard let pin, HostApiPinning.isValidFingerprint(pin) else { return nil }
        guard !host.isEmpty, host.count <= 253, !host.contains("%"), !host.contains(":"),
              !host.contains("/"), !host.contains("?"), !host.contains("@"), !host.contains("#"),
              !host.hasPrefix("-"), !host.hasSuffix("."), !host.hasSuffix("-") else { return nil }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return nil }
        // A public IP literal is never a hub name; only DNS labels are accepted here.
        if labels.count == 4 && labels.allSatisfy({ Int($0) != nil }) { return nil }
        guard labels.allSatisfy({ label in
            !label.isEmpty && label.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-")
                && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }) else { return nil }
        return host.lowercased()
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
        // The prefix only means something on a full 4-digit first group: "fc::1" is fc::/16-ish, not fc00::/7.
        let first = lower.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        guard first.count == 4 else { return false }
        if first.hasPrefix("fe8") || first.hasPrefix("fe9")
            || first.hasPrefix("fea") || first.hasPrefix("feb") { return true }  // fe80::/10
        if first.hasPrefix("fc") || first.hasPrefix("fd") { return true }        // fc00::/7 ULA
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

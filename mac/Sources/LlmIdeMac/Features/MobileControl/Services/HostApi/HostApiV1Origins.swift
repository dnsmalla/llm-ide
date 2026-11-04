import Foundation
import SharedProtocol

/// The Host API v1 web Origin allowlist (plan decision 6), the Swift twin of the Node host's rule; both are
/// pinned by `schema/host-api/v1/fixtures/security/origins.json`. A handshake with no `Origin` (iOS, CLI)
/// passes; one whose `Origin` is not an exact (case-insensitive) entry is refused before the socket opens.
enum HostApiV1Origins {
    static let environmentKey = "LLMIDE_HOST_API_WEB_ORIGINS"
    static let defaultsKey = "HostApiV1.webOrigins"

    // Literally the Node patterns, so the two hosts can never drift.
    private static let loopback = try! NSRegularExpression(pattern: #"^http://(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$"#)
    private static let https = try! NSRegularExpression(
        pattern: #"^https://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::([0-9]{1,5}))?$"#)

    static func configured(environment: [String: String], defaults: UserDefaults) -> String {
        environment[environmentKey] ?? defaults.string(forKey: defaultsKey) ?? ""
    }

    /// Comma-separated entries → the normalised allowlist. Each invalid entry is logged by name and dropped.
    static func parse(_ raw: String, log: (String) -> Void) -> [String] {
        var out: [String] = []
        for piece in raw.split(separator: ",", omittingEmptySubsequences: true) {
            let entry = piece.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if entry.isEmpty { continue }
            guard let normalised = normalise(entry) else {
                log("Host API v1: ignoring web origin \"\(HostApiFrame.clamp(entry, maxUTF16: 200))\" — only exact http://localhost|127.0.0.1|[::1]:<port> or https://<dns-name>[:port] entries are allowed")
                continue
            }
            if !out.contains(normalised) { out.append(normalised) }
        }
        return out
    }

    /// More than one `Origin` header is refused outright, like Node (which joins them into a never-listed "a, b").
    static func refused(headers: [(name: String, value: String)], allowlist: [String]) -> Bool {
        let origins = headers.filter { $0.name.lowercased() == "origin" }
        return origins.count > 1 || (origins.count == 1 && !allowlist.contains(origins[0].value.lowercased()))
    }

    private static func normalise(_ entry: String) -> String? {
        if let m = match(loopback, entry) {
            return validPort(m[2]) ? entry : nil
        }
        if let m = match(https, entry) {
            let host = m[1] ?? ""
            if host.allSatisfy({ $0.isNumber || $0 == "." }) { return nil }   // IP literals are not domains
            guard let port = m[2] else { return entry }
            guard validPort(port) else { return nil }
            return Int(port) == 443 ? "https://\(host)" : entry
        }
        return nil
    }

    private static func validPort(_ s: String?) -> Bool {
        guard let s, let p = Int(s) else { return false }
        return (1...65_535).contains(p)
    }

    /// Capture groups (index 0 = whole match), nil for a group that did not participate.
    private static func match(_ re: NSRegularExpression, _ s: String) -> [String?]? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
    }
}

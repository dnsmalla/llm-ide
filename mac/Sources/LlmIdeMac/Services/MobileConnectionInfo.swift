import Foundation
import Darwin

/// Shell-free local network discovery for the Mobile Control connection
/// panel. Enumerates interfaces via `getifaddrs` so the app never spawns a
/// process just to learn its own address — same "don't shell out" stance as
/// `BackendManager`'s node detection.
enum LocalIPs {

    /// The Tailscale address if Tailscale is up. Tailscale assigns each node
    /// a host out of the CGNAT range 100.64.0.0/10 on a `utun` interface.
    static func tailscaleIPv4() -> String? {
        interfaces().first(where: { isTailscaleCGNAT($0.ip) })?.ip
    }

    /// Installed Tailscale.app (App Store GUI build), if present on disk.
    /// Shell-free (`FileManager`) — same "don't spawn a process" stance as the
    /// rest of this enum. Lets the connection panel offer an "Open Tailscale"
    /// affordance when no CGNAT address is up yet (app installed but stopped).
    static func tailscaleAppURL() -> URL? {
        let candidates = [
            "/Applications/Tailscale.app",
            NSString(string: "~/Applications/Tailscale.app").expandingTildeInPath,
        ]
        guard let path = candidates.first(where: {
            FileManager.default.fileExists(atPath: $0)
        }) else { return nil }
        return URL(fileURLWithPath: path)
    }

    /// First usable LAN IPv4 (Wi-Fi/Ethernet). Skips loopback, Tailscale, and
    /// link-local self-assigned addresses, and prefers `en*` interfaces so a
    /// Docker/VM bridge never wins over real Wi-Fi.
    static func lanIPv4() -> String? {
        let all = interfaces()
        let preferred = all.filter { $0.iface.hasPrefix("en") }
        let pool = preferred.isEmpty ? all : preferred
        return pool.first(where: { entry in
            let ip = entry.ip
            return ip != "127.0.0.1"
                && !isTailscaleCGNAT(ip)
                && !ip.hasPrefix("169.254")
        })?.ip
    }

    /// True iff `ip` is in Tailscale's CGNAT range 100.64.0.0/10 — first
    /// octet 100, second octet 64–127.
    private static func isTailscaleCGNAT(_ ip: String) -> Bool {
        let parts = ip.split(separator: ".")
        guard parts.count == 4,
              let a = Int(parts[0]),
              let b = Int(parts[1]) else { return false }
        return a == 100 && (64...127).contains(b)
    }

    /// Every IPv4 currently assigned to any interface, as
    /// `(interfaceName, dottedQuad)` pairs.
    private static func interfaces() -> [(iface: String, ip: String)] {
        var results: [(iface: String, ip: String)] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return [] }
        defer { freeifaddrs(ifaddr) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            let entry = current.pointee
            if let addr = entry.ifa_addr, addr.pointee.sa_family == sa_family_t(AF_INET) {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                let len = socklen_t(MemoryLayout<sockaddr_in>.size)
                if getnameinfo(addr, len, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                    results.append((String(cString: entry.ifa_name), String(cString: host)))
                }
            }
            cursor = entry.ifa_next
        }
        return results
    }
}

/// Reads the mobile-pairing PIN from the macOS Keychain via `MobilePin`
/// (account `mobile::pin`), so the value surfaced in Settings always matches
/// the PIN a new iPhone connection must present in its `Pairing` frame.
/// Replaces the old file-based `~/.aicontrol.json` read.
enum AgentPin {
    static func read() -> String? { MobilePin.read() }
}

/// Snapshot of everything the iPhone app needs to connect: the Tailscale
/// and/or local Wi-Fi address, the agent port, the PIN, and a pairing QR
/// payload. Refreshable on demand — IPs change when the user joins/leaves
/// Tailscale or switches Wi-Fi.
struct MobileConnectionInfo: Equatable {
    let tailscaleIP: String?
    let lanIP: String?
    let port: Int
    let pin: String?
    /// `llmide://pair?ip=<host>&port=<port>&pin=<pin>` for the iPhone app to
    /// scan, or nil when no LAN/Tailscale address is available. Prefers the
    /// Tailscale address (works across networks) over local Wi-Fi.
    let qrPayload: String?

    static func current(port: Int = MobileControlManager.defaultAgentPort) -> MobileConnectionInfo {
        let tailscaleIP = LocalIPs.tailscaleIPv4()
        let lanIP = LocalIPs.lanIPv4()
        let pin = AgentPin.read()
        let host = tailscaleIP ?? lanIP
        let qr = host.flatMap { host -> String? in
            var c = URLComponents()
            c.scheme = "llmide"; c.host = "pair"
            c.queryItems = [
                URLQueryItem(name: "ip", value: host),
                URLQueryItem(name: "port", value: String(port)),
                URLQueryItem(name: "pin", value: pin ?? "")
            ]
            return c.url?.absoluteString
        }
        return MobileConnectionInfo(
            tailscaleIP: tailscaleIP,
            lanIP: lanIP,
            port: port,
            pin: pin,
            qrPayload: qr
        )
    }
}

import Foundation

/// Brute-force defence for mobile pairing, keyed by remote host.
///
/// The pairing secret is a 6-digit PIN (`MobilePin`), i.e. 10^6 candidates. With
/// unlimited attempts a LAN peer exhausts that in hours, so the PIN alone is not
/// an auth boundary — this policy is. Each failed attempt from a host earns an
/// escalating delay; after `lockoutThreshold` failures the host is refused
/// outright for `lockoutDuration`, which drops the achievable rate to a few
/// guesses per hour. A successful pairing wipes the host's history.
///
/// Per-HOST (not per-connection): the remote port changes on every reconnect, so
/// keying on the full endpoint would reset the counter for free. Per-host also
/// means one attacker can never lock out the real phone.
///
/// Pure value type with an injected clock so the policy is unit-testable without
/// sleeping; `MobileWebSocketServer` owns the instance and touches it only on its
/// serial queue.
struct PairingThrottle {

    enum Decision: Equatable {
        /// The host may attempt a pairing now.
        case allow
        /// Too soon after a failure — wait this long.
        case wait(TimeInterval)
        /// THIS host failed too many times; refused for the lockout window.
        case lockedOut
        /// The SERVER-WIDE failure budget is spent (an attacker spreading
        /// guesses across hosts/prefixes). Distinct from `lockedOut` because
        /// the refused peer may have a clean record — it must not be told it
        /// entered too many wrong PINs.
        case serverThrottled
    }

    /// Failures from one host before it is locked out entirely.
    static let lockoutThreshold = 8
    /// How long a locked-out host stays refused.
    static let lockoutDuration: TimeInterval = 15 * 60
    /// First failure's penalty; doubles per subsequent failure up to `delayCap`.
    static let baseDelay: TimeInterval = 1
    /// Ceiling on the escalating delay (the lockout takes over past that).
    static let delayCap: TimeInterval = 120

    private struct Record {
        var failures: Int
        var lastFailure: Date
    }

    private var records: [String: Record] = [:]
    /// Second gate: failures across ALL hosts in the current window. Per-host
    /// throttling alone is defeated by rotating source addresses (a /64, a
    /// cooperating set of LAN hosts), so once the whole server has seen this
    /// many failures every host waits out `lockoutDuration`.
    private var globalFailures = 0
    private var globalWindowStart: Date?
    static let globalThreshold = 40
    /// Hosts that have completed a pairing. They are exempt from the global
    /// gate: reaching it requires the PIN, so an attacker can't join this set,
    /// and without the exemption 40 spread-out failures would park the REAL
    /// phone in a hard refusal for the whole window — the one thing the
    /// per-host design exists to prevent.
    private var trustedHosts: Set<String> = []

    /// Whether `host` may attempt a pairing at `now`.
    func decision(for host: String, now: Date) -> Decision {
        if let start = globalWindowStart, !trustedHosts.contains(host) {
            if now.timeIntervalSince(start) >= Self.lockoutDuration {
                // Window expired — the counters are reset lazily on the next
                // failure (see registerFailure), so just stop refusing here.
            } else if globalFailures >= Self.globalThreshold {
                return .serverThrottled
            }
        }
        guard let record = records[host] else { return .allow }
        let sinceLast = now.timeIntervalSince(record.lastFailure)
        if record.failures >= Self.lockoutThreshold, sinceLast < Self.lockoutDuration {
            return .lockedOut
        }
        let penalty = Self.delay(forFailureCount: record.failures)
        if sinceLast < penalty {
            return .wait(penalty - sinceLast)
        }
        return .allow
    }

    mutating func registerFailure(host: String, now: Date) {
        if let start = globalWindowStart, now.timeIntervalSince(start) >= Self.lockoutDuration {
            globalFailures = 0
            globalWindowStart = nil
        }
        if globalWindowStart == nil { globalWindowStart = now }
        globalFailures += 1
        var record = records[host] ?? Record(failures: 0, lastFailure: now)
        record.failures += 1
        record.lastFailure = now
        records[host] = record
        // Bound the table: an attacker cycling source addresses must not grow
        // it without limit. Anything past its lockout window is inert anyway.
        if records.count > 128 {
            let cutoff = now.addingTimeInterval(-Self.lockoutDuration * 2)
            records = records.filter { $0.value.lastFailure > cutoff }
        }
    }

    /// A host that paired successfully starts over — an honest phone that
    /// fat-fingered its PIN twice must not carry a penalty afterwards.
    mutating func registerSuccess(host: String) {
        records.removeValue(forKey: host)
        // Getting here required the PIN, so this host is a known-good peer and
        // stays reachable even while an attacker is burning the global budget.
        trustedHosts.insert(host)
        if trustedHosts.count > 16 { trustedHosts.removeFirst() }
    }

    /// The /64 prefix of an IPv6 literal — the smallest block a single
    /// attacker is assumed to control. Falls back to the input when it can't
    /// be parsed (never widens the key by accident).
    static func ipv6PrefixKey(_ address: String) -> String {
        let bare = String(address.split(separator: "%").first ?? "")
        guard bare.contains(":") else { return address }
        // Expand a single "::" so the first four groups can be read positionally.
        let halves = bare.components(separatedBy: "::")
        var groups: [String]
        if halves.count == 2 {
            let head = halves[0].split(separator: ":").map(String.init)
            let tail = halves[1].split(separator: ":").map(String.init)
            let missing = max(0, 8 - head.count - tail.count)
            groups = head + Array(repeating: "0", count: missing) + tail
        } else {
            groups = bare.split(separator: ":").map(String.init)
        }
        guard groups.count >= 4 else { return bare }
        // Normalize case + leading zeros so `FE80::1`, `fe80:0000::1` and
        // `fe80::1` collapse to the same bucket.
        let prefix = groups.prefix(4).map { group -> String in
            let trimmed = group.lowercased().drop(while: { $0 == "0" })
            return trimmed.isEmpty ? "0" : String(trimmed)
        }
        return prefix.joined(separator: ":") + "::/64"
    }

    private static func delay(forFailureCount count: Int) -> TimeInterval {
        guard count > 0 else { return 0 }
        // 1s, 2s, 4s, … capped. `min` on the exponent keeps `pow` in range for
        // an absurd count.
        let exponent = Double(min(count - 1, 20))
        return min(baseDelay * pow(2, exponent), delayCap)
    }
}

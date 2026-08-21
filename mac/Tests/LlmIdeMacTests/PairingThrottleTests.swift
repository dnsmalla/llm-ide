import Testing
import Foundation
@testable import LlmIdeMacLib

/// The pairing PIN is only 6 digits, so the ONLY thing standing between a LAN
/// peer and the paired Mac is a limit on how fast it may guess. These pin the
/// policy: escalating delay per failure, hard lockout after a threshold, and a
/// clean slate once a host pairs successfully.
struct PairingThrottleTests {

    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    @Test("a fresh host is allowed immediately")
    func freshHostAllowed() {
        let throttle = PairingThrottle()
        #expect(throttle.decision(for: "192.168.1.5", now: t0) == .allow)
    }

    @Test("each failure delays the next attempt, escalating")
    func escalatingDelay() {
        var throttle = PairingThrottle()
        throttle.registerFailure(host: "10.0.0.2", now: t0)
        // Immediately after a failure the host must wait.
        #expect(throttle.decision(for: "10.0.0.2", now: t0) != .allow)
        // …and is allowed again once its delay has elapsed.
        #expect(throttle.decision(for: "10.0.0.2", now: t0.addingTimeInterval(1.5)) == .allow)

        throttle.registerFailure(host: "10.0.0.2", now: t0.addingTimeInterval(1.5))
        // The second failure's delay is strictly longer than the first's.
        #expect(throttle.decision(for: "10.0.0.2", now: t0.addingTimeInterval(3.0)) != .allow)
    }

    @Test("the lockout threshold refuses a host outright")
    func lockoutAfterThreshold() {
        var throttle = PairingThrottle()
        var now = t0
        for _ in 0..<PairingThrottle.lockoutThreshold {
            throttle.registerFailure(host: "1.2.3.4", now: now)
            // Wait out the escalating per-failure delay, which is capped at
            // delayCap — derived, not a magic number. A hardcoded 600 s here
            // silently outlived a reduction of lockoutDuration to 15 min: it
            // pushed the LAST failure so far back that `now + lockoutDuration/2`
            // already sat outside the lockout window, so the "still locked out"
            // assertion below failed. Deriving both from the constants keeps
            // this test honest when they are tuned again.
            now = now.addingTimeInterval(PairingThrottle.delayCap + 1)
        }
        #expect(throttle.decision(for: "1.2.3.4", now: now) == .lockedOut)
        // Still locked out well inside the window…
        #expect(throttle.decision(for: "1.2.3.4",
                                  now: now.addingTimeInterval(PairingThrottle.lockoutDuration / 2)) == .lockedOut)
        // …and allowed again after it expires.
        #expect(throttle.decision(for: "1.2.3.4",
                                  now: now.addingTimeInterval(PairingThrottle.lockoutDuration + 1)) == .allow)
    }

    @Test("throttling is per host — one attacker never locks out the real phone")
    func perHostIsolation() {
        var throttle = PairingThrottle()
        var now = t0
        for _ in 0..<PairingThrottle.lockoutThreshold {
            throttle.registerFailure(host: "9.9.9.9", now: now)
            now = now.addingTimeInterval(600)
        }
        #expect(throttle.decision(for: "9.9.9.9", now: now) == .lockedOut)
        #expect(throttle.decision(for: "192.168.1.20", now: now) == .allow)
    }

    @Test("a successful pairing clears the host's failure history")
    func successResets() {
        var throttle = PairingThrottle()
        throttle.registerFailure(host: "192.168.1.7", now: t0)
        throttle.registerFailure(host: "192.168.1.7", now: t0.addingTimeInterval(10))
        throttle.registerSuccess(host: "192.168.1.7")
        #expect(throttle.decision(for: "192.168.1.7", now: t0.addingTimeInterval(10)) == .allow)
    }

    // The per-host counter alone is not a limit: an on-link attacker owns a
    // whole /64 and can pick a new source address per guess. Keying on the /64
    // collapses those into one bucket.
    @Test("IPv6 addresses in one /64 share a throttle bucket")
    func ipv6PrefixKeying() {
        #expect(PairingThrottle.ipv6PrefixKey("2001:db8:1:2:aaaa::1")
                == PairingThrottle.ipv6PrefixKey("2001:db8:1:2:ffff::9"))
        #expect(PairingThrottle.ipv6PrefixKey("2001:db8:1:2::1")
                != PairingThrottle.ipv6PrefixKey("2001:db8:1:3::1"))
        // Zone id ignored, non-IPv6 passed through unchanged.
        #expect(PairingThrottle.ipv6PrefixKey("fe80::1%en0") == PairingThrottle.ipv6PrefixKey("fe80::2"))
        #expect(PairingThrottle.ipv6PrefixKey("192.168.1.5") == "192.168.1.5")
        // One /64 must be ONE key regardless of case or zero padding.
        #expect(PairingThrottle.ipv6PrefixKey("FE80::1") == PairingThrottle.ipv6PrefixKey("fe80::1"))
        #expect(PairingThrottle.ipv6PrefixKey("fe80:0000:0000:0000::1")
                == PairingThrottle.ipv6PrefixKey("fe80::1"))
    }

    // Second gate: a cooperating set of hosts (or a rotated prefix) must not
    // buy an unbounded number of guesses just by spreading them out.
    @Test("a server-wide failure budget locks out every host")
    func globalBudget() {
        var throttle = PairingThrottle()
        for index in 0..<PairingThrottle.globalThreshold {
            // A fresh host each time — per-host throttling alone sees nothing.
            throttle.registerFailure(host: "10.0.\(index / 256).\(index % 256)", now: t0)
        }
        #expect(throttle.decision(for: "10.9.9.9", now: t0) == .serverThrottled)
        // The window expires.
        #expect(throttle.decision(for: "10.9.9.9",
                                  now: t0.addingTimeInterval(PairingThrottle.lockoutDuration + 1)) == .allow)
    }

    // The whole point of per-host throttling is that an attacker cannot lock
    // out the real phone. The server-wide budget would have broken exactly
    // that promise, so a host that has paired before stays exempt.
    @Test("a previously paired host is exempt from the server-wide budget")
    func trustedHostBypassesGlobalGate() {
        var throttle = PairingThrottle()
        throttle.registerSuccess(host: "192.168.1.42")          // the real phone
        for index in 0..<PairingThrottle.globalThreshold {       // attacker spreads out
            throttle.registerFailure(host: "10.0.\(index / 256).\(index % 256)", now: t0)
        }
        #expect(throttle.decision(for: "10.9.9.9", now: t0) == .serverThrottled)
        #expect(throttle.decision(for: "192.168.1.42", now: t0) == .allow)
    }

    // A 6-digit PIN with unlimited guesses falls in hours. With the policy in
    // place, the same budget buys a vanishingly small fraction of the space —
    // this asserts the ORDER of magnitude, not an exact number, so tuning the
    // constants stays free while a regression to "no throttle" fails.
    @Test("the policy makes exhausting a 6-digit space infeasible")
    func bruteForceInfeasible() {
        var throttle = PairingThrottle()
        var now = t0
        var guesses = 0
        let deadline = t0.addingTimeInterval(24 * 60 * 60) // one day of trying
        while now < deadline {
            switch throttle.decision(for: "attacker", now: now) {
            case .allow:
                guesses += 1
                throttle.registerFailure(host: "attacker", now: now)
            case .wait(let seconds):
                now = now.addingTimeInterval(seconds)
            case .lockedOut, .serverThrottled:
                // Both refuse until a lockout window elapses — the per-host
                // one for .lockedOut, the server-wide budget's for
                // .serverThrottled — so an attacker's only move is to wait it
                // out. (This case was added to Decision without updating the
                // switch, which broke the whole test target's compile.)
                now = now.addingTimeInterval(PairingThrottle.lockoutDuration)
            }
            now = now.addingTimeInterval(0.05) // LAN round-trip
        }
        #expect(guesses < 5_000, "a day of guessing must cover well under 1% of 10^6")
    }
}

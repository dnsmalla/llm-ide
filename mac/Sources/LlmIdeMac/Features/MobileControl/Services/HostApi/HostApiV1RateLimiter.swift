import Foundation

/// Host API v1 per-session rate limits (Plan 6 Task 8), the twin of `extension/routes/host-api/rate.mjs`.
/// Buckets live in the gateway and are deleted with the session. Times in seconds (Node uses ms).
enum HostApiV1RateLimits {
    static let frameCapacity: Double = 40, framePerSecond: Double = 10   // per session
    static let turnCapacity: Double = 6, turnPerSecond: Double = 0.1     // chat.send, per device
    static let closeAfterRefusals = 100                                  // rate refusals before the session is closed
}

struct HostApiV1TokenBucket {
    let capacity: Double, perSecond: Double
    private var tokens: Double
    private var last: Date

    init(capacity: Double, perSecond: Double, now: Date) {
        self.capacity = capacity; self.perSecond = perSecond; self.tokens = capacity; self.last = now
    }

    /// nil when allowed, else the wait until one token is back.
    mutating func take(now: Date) -> TimeInterval? {
        tokens = min(capacity, tokens + max(0, now.timeIntervalSince(last)) * perSecond)
        last = max(last, now)
        if tokens >= 1 { tokens -= 1; return nil }
        return (1 - tokens) / perSecond
    }
}

struct HostApiV1RateLimiter {
    private var frames: [Int: HostApiV1TokenBucket] = [:]
    private var turns: [String: HostApiV1TokenBucket] = [:]   // bounded by the paired devices
    private var refusals: [Int: Int] = [:]

    mutating func frame(session: Int, now: Date) -> TimeInterval? {
        frames[session, default: .init(capacity: HostApiV1RateLimits.frameCapacity, perSecond: HostApiV1RateLimits.framePerSecond, now: now)].take(now: now)
    }

    mutating func turn(deviceId: String, now: Date) -> TimeInterval? {
        turns[deviceId, default: .init(capacity: HostApiV1RateLimits.turnCapacity, perSecond: HostApiV1RateLimits.turnPerSecond, now: now)].take(now: now)
    }

    /// Counts one rate refusal; true means close the session.
    mutating func refused(session: Int) -> Bool {
        refusals[session, default: 0] += 1
        return refusals[session]! >= HostApiV1RateLimits.closeAfterRefusals
    }

    mutating func drop(session: Int) {
        frames.removeValue(forKey: session)
        refusals.removeValue(forKey: session)
    }
}

// Host API v1 per-session rate limits (Plan 6 Task 8), the twin of the Mac's HostApiV1RateLimiter.swift. Buckets live
// in the gateway and are deleted with the session; never the global, persisted server/rate-limit.mjs. Times in ms.
export const RATE_LIMITS = Object.freeze({
  frameCapacity: 40, framePerSecond: 10, // per session
  turnCapacity: 6, turnPerSecond: 0.1,   // chat.send, per device
  readCapacity: 20, readPerSecond: 2,    // read commands, per device: each can read up to ~768 KiB from SQLite
  closeAfterRefusals: 100,               // rate refusals before the session is closed
});

export class TokenBucket {
  constructor(capacity, perSecond, now) {
    this.capacity = capacity; this.perSecond = perSecond; this.tokens = capacity; this.last = now;
  }

  /** null when allowed, else the wait in ms until one token is back. */
  take(now) {
    this.tokens = Math.min(this.capacity, this.tokens + (Math.max(0, now - this.last) / 1000) * this.perSecond);
    this.last = Math.max(this.last, now);
    if (this.tokens >= 1) { this.tokens -= 1; return null; }
    return Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
  }
}

export function createRateLimiter(limits = RATE_LIMITS) {
  const frames = new Map(); // session -> TokenBucket
  const turns = new Map();  // deviceId -> TokenBucket (bounded by the paired devices)
  const reads = new Map(); // deviceId -> TokenBucket (bounded by the paired devices)
  const refusals = new Map(); // session -> count
  const take = (map, key, cap, rate, now) => {
    let b = map.get(key);
    if (!b) { b = new TokenBucket(cap, rate, now); map.set(key, b); }
    return b.take(now);
  };
  return {
    frame: (session, now) => take(frames, session, limits.frameCapacity, limits.framePerSecond, now),
    turn: (deviceId, now) => take(turns, deviceId, limits.turnCapacity, limits.turnPerSecond, now),
    read: (deviceId, now) => take(reads, deviceId, limits.readCapacity, limits.readPerSecond, now),
    /** Counts one rate refusal; true means close the session. */
    refused(session) {
      const n = (refusals.get(session) ?? 0) + 1;
      refusals.set(session, n);
      return n >= limits.closeAfterRefusals;
    },
    drop(session) { frames.delete(session); refusals.delete(session); },
  };
}

// Pairing brute-force defence, ported from the Mac PairingThrottle.swift (same constants). Per-peer
// escalating delay, lockout after LOCKOUT_THRESHOLD failures, plus a server-wide failure budget that
// trusted (already paired) peers are exempt from. Clock injected; all times in ms.
export const LOCKOUT_THRESHOLD = 8;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const BASE_DELAY_MS = 1000;
export const DELAY_CAP_MS = 120_000;
export const GLOBAL_THRESHOLD = 40;
const MAX_RECORDS = 128;
const MAX_TRUSTED = 16;

const delayFor = (n) => (n > 0 ? Math.min(BASE_DELAY_MS * 2 ** Math.min(n - 1, 20), DELAY_CAP_MS) : 0);

export class PairingThrottle {
  #records = new Map(); // peer -> { failures, lastFailure }
  #globalFailures = 0;
  #globalStart = null;
  #trusted = new Set();

  decision(peer, now) {
    if (this.#globalStart !== null && !this.#trusted.has(peer)
        && now - this.#globalStart < LOCKOUT_MS && this.#globalFailures >= GLOBAL_THRESHOLD) {
      return { kind: 'serverThrottled', ms: LOCKOUT_MS - (now - this.#globalStart) };
    }
    const r = this.#records.get(peer);
    if (!r) return { kind: 'allow' };
    const since = now - r.lastFailure;
    if (r.failures >= LOCKOUT_THRESHOLD && since < LOCKOUT_MS) return { kind: 'lockedOut', ms: LOCKOUT_MS - since };
    const penalty = delayFor(r.failures);
    return since < penalty ? { kind: 'wait', ms: penalty - since } : { kind: 'allow' };
  }

  failure(peer, now) {
    if (this.#globalStart !== null && now - this.#globalStart >= LOCKOUT_MS) { this.#globalFailures = 0; this.#globalStart = null; }
    if (this.#globalStart === null) this.#globalStart = now;
    this.#globalFailures += 1;
    const r = this.#records.get(peer) ?? { failures: 0, lastFailure: now };
    r.failures += 1;
    r.lastFailure = now;
    this.#records.set(peer, r);
    if (this.#records.size > MAX_RECORDS) {
      for (const [p, v] of this.#records) if (v.lastFailure <= now - LOCKOUT_MS * 2) this.#records.delete(p);
    }
  }

  success(peer) {
    this.#records.delete(peer);
    this.#trusted.add(peer);
    if (this.#trusted.size > MAX_TRUSTED) this.#trusted.delete(this.#trusted.values().next().value);
  }
}

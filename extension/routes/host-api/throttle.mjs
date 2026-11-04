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

/** Bucket a peer address: IPv4-mapped IPv6 -> the IPv4 string, other IPv6 -> its normalised /64, IPv4 unchanged. */
export function peerKey(address) {
  const a = String(address ?? '').split('%')[0];
  if (!a.includes(':')) return String(address ?? '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) return mapped[1];
  const halves = a.split('::');
  let groups;
  if (halves.length === 2) {
    const head = halves[0].split(':').filter(Boolean);
    const tail = halves[1].split(':').filter(Boolean);
    groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  } else groups = a.split(':');
  if (groups.length < 4) return a;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+/, '') || '0').join(':')}::/64`;
}

export class PairingThrottle {
  #records = new Map(); // peer -> { failures, lastFailure }
  #globalFailures = 0;
  #globalStart = null;
  #trusted = new Set();

  decision(peer, now) {
    peer = peerKey(peer);
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
    peer = peerKey(peer);
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
    peer = peerKey(peer);
    this.#records.delete(peer);
    // Keys are client addresses; behind a reverse proxy the caller must pass the real client address (Host API Plan 6).
    this.#trusted.add(peer);
    if (this.#trusted.size > MAX_TRUSTED) this.#trusted.delete(this.#trusted.values().next().value);
  }
}

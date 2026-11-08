// C5 device lifetime policy. Two clocks every client must agree on, pinned by schema/sync/v1/vectors/v1.json
// `devicePolicy` and executed by Node, Swift and WebCrypto:
//   - a sync manifest is readable for `validUntil` plus a 7-day grace, then `stale_manifest` (its keys may have
//     rotated while the desktop was off);
//   - a Host API device token lives at most 90 days from PAIRING, even while active, then the device re-pairs.
// Arithmetic only, no I/O, so the desktop store, the reference device and the tests can share the exact rule.

export const DAY_MS = 86_400_000;
export const MANIFEST_STALE_AFTER_MS = 7 * DAY_MS;
export const DEVICE_TOKEN_MAX_LIFETIME_MS = 90 * DAY_MS;

/** 'fresh' inside validUntil, 'withheld' after it, 'stale_manifest' once the 7-day grace is past. */
export function manifestState(validUntil, nowMs) {
  return validUntil + MANIFEST_STALE_AFTER_MS < nowMs ? 'stale_manifest' : nowMs > validUntil ? 'withheld' : 'fresh';
}

export const isStaleManifest = (validUntil, nowMs) => manifestState(validUntil, nowMs) === 'stale_manifest';

/** 'live' through exactly 90 days from pairing (the boundary is still valid), then 'expired'. */
export function deviceTokenState(pairedAt, nowMs) {
  return nowMs - pairedAt > DEVICE_TOKEN_MAX_LIFETIME_MS ? 'expired' : 'live';
}

export const isDeviceTokenExpired = (pairedAt, nowMs) => deviceTokenState(pairedAt, nowMs) === 'expired';

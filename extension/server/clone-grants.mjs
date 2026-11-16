// In-memory single-use clone grants. A grant lets the SSH server helper redeem the user's saved provider token once,
// over loopback, within 60 s. Grants are never persisted and never logged: a restart drops every live grant.
import { randomBytes } from 'node:crypto';

export const CLONE_GRANT_TTL_MS = 60_000;
// NOTE: the cap bounds memory per user; a helper needs one grant per clone, so 16 is far above normal use.
export const CLONE_GRANTS_PER_USER = 16;

/** Map of grant -> { userId, provider, expiresAt }. Insertion order is issue order, so the first match is the oldest. */
const grants = new Map();
let clock = () => Date.now();

/** Test hook: replace the clock (null restores Date.now). */
export function _setCloneGrantClockForTests(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

/** Test hook: drop every grant. */
export function _resetCloneGrantsForTests() {
  grants.clear();
}

function sweepExpired(now) {
  for (const [grant, entry] of grants) {
    if (entry.expiresAt <= now) grants.delete(grant);
  }
}

/**
 * Issue a single-use grant bound to (userId, provider). Drops the user's oldest grant beyond the per-user cap.
 * @param {string} userId Signed-in user id.
 * @param {'github' | 'gitlab'} provider Provider whose saved token the grant may redeem.
 * @returns {string} 64 lowercase hex characters (32 random bytes).
 */
export function issueCloneGrant(userId, provider) {
  const now = clock();
  sweepExpired(now);
  const mine = [...grants].filter(([, entry]) => entry.userId === userId);
  for (let excess = mine.length - CLONE_GRANTS_PER_USER + 1; excess > 0; excess -= 1) {
    grants.delete(mine[excess - 1][0]);
  }
  const grant = randomBytes(32).toString('hex');
  grants.set(grant, { userId, provider, expiresAt: now + CLONE_GRANT_TTL_MS });
  return grant;
}

/**
 * Burn a grant. A grant can be redeemed once; an unknown, used or expired grant yields null.
 * @param {string} grant The grant string.
 * @returns {{ userId: string, provider: string } | null} The grant's binding, or null when it cannot be redeemed.
 */
export function redeemCloneGrant(grant) {
  const entry = grants.get(grant);
  if (!entry) return null;
  grants.delete(grant);
  if (entry.expiresAt <= clock()) return null;
  return { userId: entry.userId, provider: entry.provider };
}

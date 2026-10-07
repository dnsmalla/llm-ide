/**
 * Tier Routing resolver
 *
 * Turns the user's tier config (server/tier-routing.mjs) into a usable
 * `{ provider, model }` for a call site, or null — and null always means
 * "take today's default path". A configured tier that cannot run right now
 * (custom provider deleted / disabled / keyless, DeepSeek without a key) is
 * null too, with one throttled warn line so a silent fall back to a pricier
 * default is visible in the log. Runtime failures of a USABLE route are not
 * this module's business: they surface exactly as before (no failover).
 *
 * Lives in providers/ rather than next to the store because usability needs
 * the provider layer (custom-provider dispatch + vault keys), which server
 * libs may not import.
 */

import { getDb } from '../kb/db.mjs';
import { logger } from '../core/logger.mjs';
import { getTierRoutingConfig, ROUTING_TIERS } from '../server/tier-routing.mjs';
import { resolveCustomProviderDispatch, providerApiKey } from './providers.mjs';

const log = logger.child({ component: 'tier-routing' });

// One warn per (user, tier, reason) per window — the resolver runs on every
// routed call, and a stale config would otherwise log on each of them.
const WARN_WINDOW_MS = 10 * 60_000;
const lastWarned = new Map();
function warnUnusable(userId, tier, route, reason) {
  const key = `${userId}|${tier}|${route.provider}|${reason}`;
  const now = Date.now();
  if (now - (lastWarned.get(key) || 0) < WARN_WINDOW_MS) return;
  lastWarned.set(key, now);
  log.warn('routing_tier_unusable', { userId, tier, provider: route.provider, reason });
}

/** Why `route` cannot run for `userId` right now, or null when it can. */
function unusableReason(route, userId, db) {
  if (route.provider.startsWith('custom:')) {
    const r = resolveCustomProviderDispatch(route.provider, userId, db);
    return r.error || null;                  // not_found | disabled | no_key
  }
  // DeepSeek is API-key-only (no CLI subscription mode); the other built-ins
  // fall back to their logged-in CLI, so a missing key is not fatal for them.
  if (route.provider === 'deepseek' && !providerApiKey(userId, 'deepseek')) return 'no_key';
  return null;
}

/**
 * The route for `tier`, or null when it is unset or unusable. Never throws —
 * a resolver fault must not fail the call it was only meant to cheapen.
 */
export function resolveTier(userId, tier, db) {
  if (!userId || !ROUTING_TIERS.includes(tier)) return null;
  try {
    db ??= getDb();
    const route = getTierRoutingConfig(userId, db).tiers[tier];
    if (!route) return null;
    const reason = unusableReason(route, userId, db);
    if (reason) {
      warnUnusable(userId, tier, route, reason);
      return null;
    }
    return { provider: route.provider, model: route.model };
  } catch (err) {
    log.warn('routing_tier_resolve_failed', { userId, tier, error: String(err?.message || err) });
    return null;
  }
}

/** The route for `feature` (via its tier), or null → the caller's default. */
export function resolveFeatureRoute(userId, feature, db) {
  if (!userId) return null;
  let tier;
  try {
    db ??= getDb();
    tier = getTierRoutingConfig(userId, db).features[feature];
  } catch { return null; }
  return tier ? resolveTier(userId, tier, db) : null;
}

/**
 * Spread-ready runClaude options for `feature`: `{ model, provider }` when
 * routed, otherwise `fallback` (default `{}` — i.e. change nothing).
 */
export function routeOpts(userId, feature, fallback = {}, db) {
  const route = resolveFeatureRoute(userId, feature, db);
  return route ? { model: route.model, provider: route.provider } : fallback;
}

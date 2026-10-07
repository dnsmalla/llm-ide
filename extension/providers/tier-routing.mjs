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
  // Every non-Anthropic built-in needs its API key. DeepSeek has no CLI mode
  // at all; OpenAI/Google without a key would fall back to runViaCli, which
  // drops the routed model and runs the codex/gemini AGENT CLI over untrusted
  // input in the server's cwd — never an acceptable silent substitute.
  // Anthropic without a key is the `claude -p` path every default call takes.
  if (route.provider !== 'anthropic' && !providerApiKey(userId, route.provider)) return 'no_key';
  return null;
}

/**
 * Why the Agent SDK engine (Loop agent steps, Agent-engine chats) cannot run
 * `route`, or null when it can. Mirrors llm_agent/sdk/engine.mjs
 * resolveAgentEngineAuth (which providers/ may not import): first-party
 * Anthropic always (its own auth ladder), a custom provider only with an
 * Anthropic-compatible endpoint and a key, nothing else.
 */
function agentUnusableReason(route, userId, db) {
  if (route.provider === 'anthropic') return null;
  if (route.provider.startsWith('custom:')) {
    const r = resolveCustomProviderDispatch(route.provider, userId, db);
    if (r.error) return r.error;
    return r.anthropicBaseUrl ? null : 'not_agent_capable';
  }
  return 'not_agent_capable';
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

/**
 * GET /kb/routing-tiers payload: the stored config plus, per tier,
 * `{ usable, reason?, agentCapable, agentReason? }` — `usable` from the same
 * check resolveTier applies (so the Mac can drop a route the server would
 * drop anyway instead of sending it and hitting a provider error), and
 * `agentCapable` for features that run on the Agent engine (Loop agent steps,
 * Agent-engine chats). An unset tier is `{ usable: false, reason: 'unset',
 * agentCapable: false }`. Never throws; a fault reports every tier unusable.
 */
export function tierRoutingStatus(userId, db) {
  const status = {};
  let cfg = { tiers: {}, features: {} };
  try {
    db ??= getDb();
    cfg = getTierRoutingConfig(userId, db);
  } catch (err) {
    log.warn('routing_tier_status_failed', { userId, error: String(err?.message || err) });
  }
  for (const tier of ROUTING_TIERS) {
    const route = cfg.tiers[tier];
    if (!route) { status[tier] = { usable: false, reason: 'unset', agentCapable: false }; continue; }
    let reason;
    let agentReason;
    try {
      reason = unusableReason(route, userId, db);
      agentReason = reason || agentUnusableReason(route, userId, db);
    } catch (err) {
      reason = 'error';
      agentReason = 'error';
      log.warn('routing_tier_status_failed', { userId, tier, error: String(err?.message || err) });
    }
    status[tier] = reason
      ? { usable: false, reason, agentCapable: false }
      : { usable: true, agentCapable: !agentReason, ...(agentReason ? { agentReason } : {}) };
  }
  return { tiers: cfg.tiers, features: cfg.features, status };
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

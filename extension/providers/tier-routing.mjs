/**
 * Tier Routing resolver
 *
 * Turns the user's tier config (server/tier-routing.mjs) into a usable
 * `{ provider, model }` for a call site, or null — and null always means
 * "take today's default path". A configured tier that cannot run right now
 * (custom provider deleted / disabled / keyless, DeepSeek without a key, a
 * keyless OpenAI/Google whose CLI is missing, unverified or failing, a route
 * that just failed at runtime) is null too, with one throttled warn line so a
 * silent fall back to a pricier default is visible in the log.
 *
 * Server-side callers get `routeOpts(…)`, which also carries the caller's
 * own default (`routeFallback`): runClaude retries a routed call that fails
 * for a non-content reason ONCE on that default and marks the route broken
 * (providers/route-health.mjs), so the next call skips it.
 *
 * Lives in providers/ rather than next to the store because usability needs
 * the provider layer (custom-provider dispatch + vault keys), which server
 * libs may not import.
 */

import { getDb } from '../kb/db.mjs';
import { logger } from '../core/logger.mjs';
import { getTierRoutingConfig, ROUTING_TIERS } from '../server/tier-routing.mjs';
import { resolveCustomProviderDispatch, providerApiKey, providerHasCli } from './providers.mjs';
import { cliHealth, awaitCliProbes, routeFailure } from './route-health.mjs';

const log = logger.child({ component: 'tier-routing' });

// Features whose prompts carry untrusted third-party text (email, connector
// items, transcripts → `internal`) or whose output is dispatched onward to
// issue trackers (`pipeline`). A keyless OpenAI/Google route runs the codex /
// gemini AGENT CLI — read-only, in an empty temp dir, but codex's read-only
// sandbox can still read absolute paths — so those routes never serve these
// features; an API-key route (plain HTTP completion) or Claude's tool-less
// `claude -p` may.
const UNTRUSTED_INPUT_FEATURES = new Set(['internal', 'pipeline']);
const AGENT_CLI_PROVIDERS = new Set(['openai', 'google']);

// CLI health for a keyless OpenAI/Google route: 'ok' | 'failed' |
// 'unverified' (route-health's cached probe — never blocks). Tests swap it;
// a boolean answer maps to ok/failed.
let cliProbe = (provider) => cliHealth(provider);

/** Test seam: replace the CLI health check (`(provider) => boolean | 'ok' | 'failed' | 'unverified'`). */
export function _setCliProbeForTests(probe) {
  cliProbe = typeof probe === 'function' ? probe : (provider) => cliHealth(provider);
}

function cliState(provider) {
  const answer = cliProbe(provider);
  if (answer === true) return 'ok';
  if (answer === false) return 'failed';
  return answer;
}

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

/**
 * Whether `route` can run for `userId` right now: `{ reason }` when it
 * cannot, else `{ via }` — 'key' (an API key: user vault or operator env;
 * custom providers always) or 'cli' (the provider's logged-in CLI). Same
 * precedence as runClaude: a key is tried first. One vault read per check.
 */
function routeCheck(route, userId, db) {
  const failed = routeFailure(userId, route.provider, route.model);
  if (failed) return { reason: failed };     // cli_failed | route_failed
  if (route.provider.startsWith('custom:')) {
    const r = resolveCustomProviderDispatch(route.provider, userId, db);
    return r.error ? { reason: r.error } : { via: 'key' };   // not_found | disabled | no_key
  }
  if (providerApiKey(userId, route.provider)) return { via: 'key' };
  // Anthropic without a key is the `claude -p` path every default call takes.
  if (route.provider === 'anthropic') return { via: 'cli' };
  // Keyless OpenAI/Google run their logged-in CLI (subscription): runViaCli
  // passes the routed model (-m) and, with no caller workspace, roots the
  // agent CLI in an empty private temp dir (codex read-only). Usable only once
  // the CLI's health probe has PASSED — never probed yet counts as unusable
  // (the probe then runs in the background). DeepSeek (and any other
  // cli: null provider) has no CLI mode at all.
  if (providerHasCli(route.provider)) {
    const state = cliState(route.provider);
    if (state === 'ok') return { via: 'cli' };
    return { reason: state === 'unverified' ? 'cli_unverified' : 'no_key_or_cli' };
  }
  return { reason: 'no_key' };
}

/** Why `feature` may not take a usable route with `via`, or null. */
function featureReason(feature, route, via) {
  if (via === 'cli' && AGENT_CLI_PROVIDERS.has(route.provider) && UNTRUSTED_INPUT_FEATURES.has(feature)) {
    return 'cli_untrusted_input';
  }
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

// The usable `{ route, via }` for `tier`, or null (warned once per window).
function checkTier(userId, tier, db) {
  if (!userId || !ROUTING_TIERS.includes(tier)) return null;
  try {
    db ??= getDb();
    const route = getTierRoutingConfig(userId, db).tiers[tier];
    if (!route) return null;
    const check = routeCheck(route, userId, db);
    if (check.reason) {
      warnUnusable(userId, tier, route, check.reason);
      return null;
    }
    return { route, via: check.via };
  } catch (err) {
    log.warn('routing_tier_resolve_failed', { userId, tier, error: String(err?.message || err) });
    return null;
  }
}

/**
 * The route for `tier`, or null when it is unset or unusable. Never throws —
 * a resolver fault must not fail the call it was only meant to cheapen.
 */
export function resolveTier(userId, tier, db) {
  const hit = checkTier(userId, tier, db);
  return hit ? { provider: hit.route.provider, model: hit.route.model } : null;
}

/**
 * GET /kb/routing-tiers payload: the stored config plus, per tier,
 * `{ usable, reason?, agentCapable, agentReason?, via? }` — `usable` from the
 * same check resolveTier applies (so the Mac can drop a route the server would
 * drop anyway instead of sending it and hitting a provider error),
 * `agentCapable` for features that run on the Agent engine (Loop agent steps,
 * Agent-engine chats), and on a usable tier `via` ('key' | 'cli') — whether it
 * runs on an API key or the logged-in CLI subscription. An unset tier is
 * `{ usable: false, reason: 'unset', agentCapable: false }`.
 *
 * `featureStatus` (API v69+) has one `{ usable, reason? }` per CONFIGURED
 * feature: a feature is unusable when its tier is (same reason) or when the
 * tier's route may not serve it (`cli_untrusted_input`). Never throws; a
 * fault reports every tier unusable.
 */
export function tierRoutingStatus(userId, db) {
  const status = {};
  const featureStatus = {};
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
    let check;
    let agentReason;
    try {
      check = routeCheck(route, userId, db);
      agentReason = check.reason || agentUnusableReason(route, userId, db);
    } catch (err) {
      check = { reason: 'error' };
      agentReason = 'error';
      log.warn('routing_tier_status_failed', { userId, tier, error: String(err?.message || err) });
    }
    status[tier] = check.reason
      ? { usable: false, reason: check.reason, agentCapable: false }
      : { usable: true, agentCapable: !agentReason, ...(agentReason ? { agentReason } : {}), via: check.via };
  }
  for (const [feature, tier] of Object.entries(cfg.features || {})) {
    const tierStatus = status[tier];
    if (!tierStatus?.usable) {
      featureStatus[feature] = { usable: false, reason: tierStatus?.reason || 'unset' };
      continue;
    }
    const reason = featureReason(feature, cfg.tiers[tier], tierStatus.via);
    featureStatus[feature] = reason ? { usable: false, reason } : { usable: true };
  }
  return { tiers: cfg.tiers, features: cfg.features, status, featureStatus };
}

/**
 * tierRoutingStatus for the Settings path (GET /kb/routing-tiers): first
 * starts the CLI health probe for every configured keyless OpenAI/Google tier
 * and waits up to `waitMs` for it, so a freshly started server answers with a
 * real verdict instead of `cli_unverified`. Never used on a model-call path.
 */
export async function tierRoutingStatusFresh(userId, db, { waitMs = 3000 } = {}) {
  try {
    db ??= getDb();
    const providers = Object.values(getTierRoutingConfig(userId, db).tiers)
      .map((route) => route.provider)
      .filter((provider) => AGENT_CLI_PROVIDERS.has(provider) && !providerApiKey(userId, provider));
    for (const provider of providers) cliProbe(provider);
    await awaitCliProbes(providers, waitMs);
  } catch (err) {
    log.warn('routing_tier_probe_wait_failed', { userId, error: String(err?.message || err) });
  }
  return tierRoutingStatus(userId, db);
}

/**
 * The route for `feature` (via its tier), or null → the caller's default.
 * A keyless OpenAI/Google (agent CLI) route never serves an untrusted-input
 * feature (`internal`, `pipeline`) — see UNTRUSTED_INPUT_FEATURES.
 */
export function resolveFeatureRoute(userId, feature, db) {
  if (!userId) return null;
  let tier;
  try {
    db ??= getDb();
    tier = getTierRoutingConfig(userId, db).features[feature];
  } catch { return null; }
  if (!tier) return null;
  const hit = checkTier(userId, tier, db);
  if (!hit) return null;
  const reason = featureReason(feature, hit.route, hit.via);
  if (reason) {
    warnUnusable(userId, `${tier}:${feature}`, hit.route, reason);
    return null;
  }
  return { provider: hit.route.provider, model: hit.route.model };
}

/**
 * The tier name `feature` is configured to (e.g. 'cheap'), or null. Display
 * only — resolveFeatureRoute decides whether that tier is usable. Never throws.
 */
export function featureTierName(userId, feature, db) {
  if (!userId) return null;
  try {
    db ??= getDb();
    const tier = getTierRoutingConfig(userId, db).features[feature];
    return typeof tier === 'string' && tier ? tier : null;
  } catch { return null; }
}

/**
 * Spread-ready runClaude options for `feature`: `{ model, provider,
 * routeFallback }` when routed — `routeFallback` is the caller's own default
 * (`fallback`), which runClaude retries once on when the routed provider
 * fails for a non-content reason — otherwise `fallback` itself (default `{}`
 * — i.e. change nothing).
 */
export function routeOpts(userId, feature, fallback = {}, db) {
  const route = resolveFeatureRoute(userId, feature, db);
  return route ? { model: route.model, provider: route.provider, routeFallback: { ...fallback } } : fallback;
}

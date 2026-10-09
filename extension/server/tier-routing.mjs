/**
 * Tier Routing store
 *
 * Per-user "which provider + model runs each role" config, synced from the
 * Mac app (`POST /kb/routing-tiers`). Three tiers (strong / standard / cheap)
 * each name a `{ provider, model }`; seven features (subagents, loop, …) each
 * name a tier. Every entry is optional — an unset feature means "today's
 * default path", which is why invalid entries are dropped rather than
 * rejected: routing must never make a normal call fail.
 *
 * Same no-migration pattern as custom-providers.mjs: one `user_flags` row
 * (`routing.tiers`) per user, an in-memory cache in front of it keyed by the
 * DB handle. Resolving a tier into a USABLE route needs the provider layer
 * (custom-provider dispatch, vault keys), which server libs may not import —
 * that half lives in providers/tier-routing.mjs.
 */

import { getDb } from '../kb/db.mjs';
import { readBody, parseJSON, sendJSON } from '../core/utils.mjs';

const FLAG = 'routing.tiers';
const MAX_BODY_BYTES = 20_000;

export const ROUTING_TIERS = Object.freeze(['strong', 'standard', 'cheap']);
// `decisions` (API v73) — the `decide` tool and other calibrated
// yes/no / pick-one / score calls (llm_agent/runtime/decide.mjs). The only
// feature a decision-only (jev) tier may serve; see providers/tier-routing.mjs.
export const ROUTED_FEATURES = Object.freeze(['subagents', 'loop', 'autoTasks', 'quickChat', 'pipeline', 'internal', 'decisions']);

// Server wire ids only. `custom:<id>` ids are the Mac's provider UUIDs (case
// preserved — the registry is keyed by the exact id the Mac sent). `jev` is
// accepted as a tier provider, but the resolver lets it serve `decisions` only.
const PROVIDER_RE = /^(anthropic|openai|google|deepseek|jev|custom:[A-Za-z0-9-]{1,100})$/;
// The model id is forwarded into a provider request body, so a strict charset.
// The one bracket form allowed is the SDK's 1M-context suffix `[1m]` (the
// Settings model menu lists e.g. `claude-opus-5-5[1m]` from the SDK's live
// list); runClaude's direct-API path strips it (runtime.mjs resolveModel), the
// CLI and Agent SDK paths accept it as is.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(\[1m\])?$/;
// Cap on reported dropped entries (and on an echoed key's length): the body is
// already capped, this just keeps the answer small whatever a client sends.
const MAX_DROPPED = 32;
const MAX_ECHO_KEY = 64;

const EMPTY = Object.freeze({ tiers: Object.freeze({}), features: Object.freeze({}) });

const caches = new WeakMap();
function cacheFor(db) {
  let c = caches.get(db);
  if (!c) { c = new Map(); caches.set(db, c); }
  return c;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Normalize a client config into `{ tiers, features }`, dropping anything
 * invalid. When `dropped` is an array, each dropped entry is appended to it as
 * `{ entry: 'tiers.<name>' | 'features.<name>', reason }` (reason ∈
 * invalid_shape | invalid_provider | invalid_model | unknown_tier |
 * unknown_feature) so the client can show why a setting did not stick.
 */
export function normalizeTierRouting(config, dropped = null) {
  const tiers = {};
  const features = {};
  const drop = (entry, reason) => {
    if (Array.isArray(dropped) && dropped.length < MAX_DROPPED) {
      dropped.push({ entry: entry.slice(0, MAX_ECHO_KEY), reason });
    }
  };
  if (!isPlainObject(config)) return { tiers, features };
  if (isPlainObject(config.tiers)) {
    for (const [name, t] of Object.entries(config.tiers)) {
      if (!ROUTING_TIERS.includes(name)) { drop(`tiers.${name}`, 'unknown_tier'); continue; }
      if (!isPlainObject(t)) { drop(`tiers.${name}`, 'invalid_shape'); continue; }
      const provider = typeof t.provider === 'string' ? t.provider.trim() : '';
      const model = typeof t.model === 'string' ? t.model.trim() : '';
      if (!PROVIDER_RE.test(provider)) { drop(`tiers.${name}`, 'invalid_provider'); continue; }
      if (!MODEL_RE.test(model)) { drop(`tiers.${name}`, 'invalid_model'); continue; }
      tiers[name] = { provider, model };
    }
  }
  if (isPlainObject(config.features)) {
    for (const [name, tier] of Object.entries(config.features)) {
      if (!ROUTED_FEATURES.includes(name)) { drop(`features.${name}`, 'unknown_feature'); continue; }
      if (typeof tier !== 'string' || !ROUTING_TIERS.includes(tier)) { drop(`features.${name}`, 'unknown_tier'); continue; }
      features[name] = tier;
    }
  }
  return { tiers, features };
}

function loadFromDb(userId, db) {
  const row = db.prepare('SELECT value FROM user_flags WHERE user_id = ? AND flag = ?').get(userId, FLAG);
  if (!row?.value) return EMPTY;
  try { return normalizeTierRouting(JSON.parse(row.value)); } catch { return EMPTY; }
}

/** `userId`'s stored config, `{ tiers, features }` (both possibly empty). */
export function getTierRoutingConfig(userId, db = getDb()) {
  if (!userId) return EMPTY;
  const cache = cacheFor(db);
  let cfg = cache.get(userId);
  if (!cfg) {
    cfg = loadFromDb(userId, db);
    cache.set(userId, cfg);
  }
  return cfg;
}

/**
 * Replace `userId`'s config (the Mac sends the whole thing on every change).
 * Other users are untouched. Returns the normalized config that was stored;
 * entries it dropped are appended to `dropped` when one is passed.
 */
export function syncTierRouting(config, userId, db = getDb(), dropped = null) {
  if (!userId) throw new Error('syncTierRouting requires a userId');
  const cfg = normalizeTierRouting(config, dropped);
  if (Object.keys(cfg.tiers).length === 0 && Object.keys(cfg.features).length === 0) {
    db.prepare('DELETE FROM user_flags WHERE user_id = ? AND flag = ?').run(userId, FLAG);
  } else {
    db.prepare(`
      INSERT INTO user_flags (user_id, flag, value) VALUES (?, ?, ?)
      ON CONFLICT(user_id, flag) DO UPDATE SET value = excluded.value, set_at = datetime('now')
    `).run(userId, FLAG, JSON.stringify(cfg));
  }
  cacheFor(db).set(userId, cfg);
  return cfg;
}

/** Test seam: forget the cache so the next read comes from the DB. */
export function _resetTierRoutingCacheForTests(db = getDb()) {
  caches.delete(db);
}

/**
 * POST /kb/routing-tiers — body `{ tiers, features }`, answers
 * `{ success: true, dropped: [{ entry, reason }] }`. Invalid entries are
 * dropped, never rejected (see header); `dropped` tells the client which.
 * (GET — the stored config plus per-tier status — needs the provider layer,
 * so it is served from providers/tier-routing.mjs.)
 */
export async function handleTierRoutingSync(req, res, userId) {
  if (req.method !== 'POST') {
    sendJSON(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
    return;
  }
  let data;
  try {
    data = parseJSON(await readBody(req, MAX_BODY_BYTES));
  } catch (err) {
    // readBody tags its own refusals with a status (413 too large, 408 slow);
    // anything else (socket error, early close) is a bad request, not a size
    // problem — same `err.status || 400` rule as auth-routes.
    const status = err?.status || 400;
    const code = status === 413 ? 'BODY_TOO_LARGE' : (err?.code || 'VALIDATION_FAILED');
    sendJSON(res, status, { error: { code, message: err?.message || 'Could not read the request body' } });
    return;
  }
  if (!isPlainObject(data)) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: '{ tiers, features } object required' } });
    return;
  }
  const dropped = [];
  syncTierRouting(data, userId, getDb(), dropped);
  sendJSON(res, 200, { success: true, dropped });
}

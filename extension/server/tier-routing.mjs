/**
 * Tier Routing store
 *
 * Per-user "which provider + model runs each role" config, synced from the
 * Mac app (`POST /kb/routing-tiers`). Three tiers (strong / standard / cheap)
 * each name a `{ provider, model }`; six features (subagents, loop, …) each
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
export const ROUTED_FEATURES = Object.freeze(['subagents', 'loop', 'autoTasks', 'quickChat', 'pipeline', 'internal']);

// Server wire ids only. `custom:<id>` ids are the Mac's provider UUIDs (case
// preserved — the registry is keyed by the exact id the Mac sent).
const PROVIDER_RE = /^(anthropic|openai|google|deepseek|custom:[A-Za-z0-9-]{1,100})$/;
// The model id is forwarded into a provider request body, so a strict charset.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const EMPTY = Object.freeze({ tiers: Object.freeze({}), features: Object.freeze({}) });

const caches = new WeakMap();
function cacheFor(db) {
  let c = caches.get(db);
  if (!c) { c = new Map(); caches.set(db, c); }
  return c;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Normalize a client config into `{ tiers, features }`, dropping anything invalid. */
export function normalizeTierRouting(config) {
  const tiers = {};
  const features = {};
  if (!isPlainObject(config)) return { tiers, features };
  if (isPlainObject(config.tiers)) {
    for (const name of ROUTING_TIERS) {
      const t = config.tiers[name];
      if (!isPlainObject(t)) continue;
      const provider = typeof t.provider === 'string' ? t.provider.trim() : '';
      const model = typeof t.model === 'string' ? t.model.trim() : '';
      if (PROVIDER_RE.test(provider) && MODEL_RE.test(model)) tiers[name] = { provider, model };
    }
  }
  if (isPlainObject(config.features)) {
    for (const name of ROUTED_FEATURES) {
      const tier = config.features[name];
      if (typeof tier === 'string' && ROUTING_TIERS.includes(tier)) features[name] = tier;
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
 * Other users are untouched. Returns the normalized config that was stored.
 */
export function syncTierRouting(config, userId, db = getDb()) {
  if (!userId) throw new Error('syncTierRouting requires a userId');
  const cfg = normalizeTierRouting(config);
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
 * `{ success: true }`. Invalid entries are dropped silently (see header).
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
    sendJSON(res, 413, { error: { code: 'BODY_TOO_LARGE', message: err?.message || 'Request body too large' } });
    return;
  }
  if (!isPlainObject(data)) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: '{ tiers, features } object required' } });
    return;
  }
  syncTierRouting(data, userId);
  sendJSON(res, 200, { success: true });
}

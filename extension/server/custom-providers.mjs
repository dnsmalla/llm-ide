/**
 * Custom Provider Registry
 *
 * User-registered LLM providers, synced from the Mac app
 * (`POST /kb/custom-providers`) and looked up by `custom:<uuid>` at dispatch.
 *
 * PER USER, and persisted. It used to be one process-global Map that every
 * sync `clear()`ed: user B's sync wiped user A's providers, and a server
 * restart wiped everyone's until each Mac happened to re-sync (turns failed
 * "Custom provider … not found" in between). Each user's list now lives in
 * `user_flags` under `custom.providers` (the same no-migration pattern as the
 * UI prefs in kb/user.mjs), with an in-memory cache in front of it.
 */

import { getDb } from '../kb/db.mjs';
import { readBody, parseJSON, sendJSON } from '../core/utils.mjs';

const FLAG = 'custom.providers';
const MAX_PROVIDERS = 50;
const MAX_BODY_BYTES = 100_000;

/** db → (userId → Map("custom:<id>" → provider)). Keyed by the DB handle too,
 * so a reopened or test database never serves another one's rows. */
const caches = new WeakMap();
function cacheFor(db) {
  let c = caches.get(db);
  if (!c) { c = new Map(); caches.set(db, c); }
  return c;
}

function normalize(p) {
  if (!p || typeof p !== 'object') return null;
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 100) : '';
  const baseURL = typeof p.baseURL === 'string' ? p.baseURL.trim() : '';
  // Stored, then dialled with the user's key — so only a real http(s) URL.
  // (Dispatch still applies its own SSRF guard at call time.)
  if (!id || id.length > 100 || !name || !/^https?:\/\/[^\s]+$/i.test(baseURL)) return null;
  const anthropicBaseURL = typeof p.anthropicBaseURL === 'string' && /^https?:\/\//i.test(p.anthropicBaseURL.trim())
    ? p.anthropicBaseURL.trim().replace(/\/+$/, '')
    : null;
  return {
    id,
    name,
    baseURL,
    vaultKey: typeof p.apiKey === 'string' ? p.apiKey : `custom.${id}.apiKey`,  // e.g. "custom.glm.apiKey"
    models: Array.isArray(p.models) ? p.models.slice(0, 200) : [],
    isOpenAICompatible: p.isOpenAICompatible !== false,
    isEnabled: p.isEnabled !== false,
    // Optional Anthropic-format door (Z.AI `…/api/anthropic`, DeepSeek
    // `…/anthropic`, Ollama `:11434`). Only the Agent SDK engine reads it:
    // the legacy loop keeps dispatching to `baseURL` (OpenAI form). Null
    // means "this provider cannot take the Agent engine".
    anthropicBaseURL,
  };
}

function toMap(list) {
  const m = new Map();
  for (const p of list) m.set(`custom:${p.id}`, p);
  return m;
}

function loadFromDb(userId, db) {
  const row = db.prepare('SELECT value FROM user_flags WHERE user_id = ? AND flag = ?').get(userId, FLAG);
  if (!row?.value) return new Map();
  try {
    const parsed = JSON.parse(row.value);
    return toMap((Array.isArray(parsed) ? parsed : []).map(normalize).filter(Boolean));
  } catch {
    return new Map();
  }
}

function providersFor(userId, db) {
  if (!userId) return new Map();
  const cache = cacheFor(db);
  let m = cache.get(userId);
  if (!m) {
    m = loadFromDb(userId, db);
    cache.set(userId, m);
  }
  return m;
}

/** The provider `providerId` (`custom:<uuid>`) registered by `userId`, or undefined. */
export function getCustomProvider(providerId, userId, db = getDb()) {
  return providersFor(userId, db).get(providerId);
}

/**
 * Replace `userId`'s providers with `providers` (the Mac sends its whole
 * list on every save). Other users are untouched. Invalid entries are
 * dropped. Returns the number stored.
 */
export function syncCustomProviders(providers = [], userId, db = getDb()) {
  if (!userId) throw new Error('syncCustomProviders requires a userId');
  const list = (Array.isArray(providers) ? providers : []).map(normalize).filter(Boolean).slice(0, MAX_PROVIDERS);
  if (list.length === 0) {
    db.prepare('DELETE FROM user_flags WHERE user_id = ? AND flag = ?').run(userId, FLAG);
  } else {
    db.prepare(`
      INSERT INTO user_flags (user_id, flag, value) VALUES (?, ?, ?)
      ON CONFLICT(user_id, flag) DO UPDATE SET value = excluded.value, set_at = datetime('now')
    `).run(userId, FLAG, JSON.stringify(list.map((p) => ({ ...p, apiKey: p.vaultKey }))));
  }
  cacheFor(db).set(userId, toMap(list));
  return list.length;
}

/** Test seam: forget the cache so the next read comes from the DB. */
export function _resetCustomProviderCacheForTests(db = getDb()) {
  caches.delete(db);
}

/**
 * POST /kb/custom-providers — body `{ providers: [CustomProvider, ...] }`,
 * answers `{ success: true, count }`. Goes through `readBody` like every
 * other POST (size cap + slow-client timeout); it used to hand-roll the read
 * with no timeout and `req.connection.destroy()` on overflow.
 */
export async function handleCustomProvidersSync(req, res, userId) {
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
  if (!data || !Array.isArray(data.providers)) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'providers array required' } });
    return;
  }
  const count = syncCustomProviders(data.providers, userId);
  sendJSON(res, 200, { success: true, count });
}

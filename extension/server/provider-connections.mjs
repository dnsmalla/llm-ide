/**
 * Per-user provider connections (the Settings "Providers" screen's data).
 *
 * A connection is one catalog entry the user turned on: its id (`cat-openai`,
 * `cat-openai-compatible-home`), the base URL, and enabled. The API KEY is not
 * stored here: it goes in the encrypted per-user vault under
 * `custom.<id>.apiKey`, the same slot a custom provider uses, so the existing
 * dispatch (`custom:<id>` → resolveCustomProviderDispatch) serves a catalog
 * connection with no new code path. server/custom-providers.mjs falls back to
 * this module for ids it does not hold.
 *
 * State is JSON under user_flags `provider.catalog` (the no-migration pattern
 * custom-providers.mjs and kb/user.mjs already use):
 *   { connections: [...], settings: { toolsEnabled, fallbackEnabled,
 *     fallbackOrder, toolOverrides } }
 * Both switches default OFF. Every read and write is keyed by userId; another
 * user's connection, key and settings are unreachable from here.
 */

import { getDb } from '../kb/db.mjs';
import { getSecret, setSecret } from './vault.mjs';
import { catalogEntry } from './provider-catalog.mjs';
import { assertProviderBaseUrl } from './base-url-guard.mjs';

const FLAG = 'provider.catalog';
const MAX_CONNECTIONS = 20;
const MAX_ORDER = 20;
const MAX_OVERRIDES = 400;
const ID_PREFIX = 'cat-';
const SLUG_RE = /^[a-z0-9]{1,24}$/;
const KEYLESS_PLACEHOLDER = 'not-required';

export const DEFAULT_SETTINGS = Object.freeze({
  toolsEnabled: false,
  fallbackEnabled: false,
  fallbackOrder: [],
  toolOverrides: {},
});

/** Vault key for a connection id. */
export function vaultKeyFor(id) { return `custom.${id}.apiKey`; }

function read(db, userId) {
  if (!userId) return { connections: [], settings: { ...DEFAULT_SETTINGS } };
  const row = db.prepare('SELECT value FROM user_flags WHERE user_id = ? AND flag = ?').get(userId, FLAG);
  let parsed = null;
  try { parsed = row?.value ? JSON.parse(row.value) : null; } catch { parsed = null; }
  return {
    connections: Array.isArray(parsed?.connections) ? parsed.connections.filter((c) => c && typeof c.id === 'string') : [],
    settings: normalizeSettings(parsed?.settings),
  };
}

function write(db, userId, state) {
  db.prepare(`
    INSERT INTO user_flags (user_id, flag, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, flag) DO UPDATE SET value = excluded.value, set_at = datetime('now')
  `).run(userId, FLAG, JSON.stringify(state));
}

function normalizeSettings(s) {
  const out = { ...DEFAULT_SETTINGS, fallbackOrder: [], toolOverrides: {} };
  if (!s || typeof s !== 'object') return out;
  out.toolsEnabled = s.toolsEnabled === true;
  out.fallbackEnabled = s.fallbackEnabled === true;
  if (Array.isArray(s.fallbackOrder)) {
    out.fallbackOrder = s.fallbackOrder
      .filter((e) => e && typeof e.provider === 'string' && e.provider.startsWith(`custom:${ID_PREFIX}`))
      .map((e) => ({ provider: e.provider, ...(typeof e.model === 'string' && e.model ? { model: e.model.slice(0, 200) } : {}) }))
      .slice(0, MAX_ORDER);
  }
  if (s.toolOverrides && typeof s.toolOverrides === 'object') {
    for (const [k, v] of Object.entries(s.toolOverrides).slice(0, MAX_OVERRIDES)) {
      if (typeof v === 'boolean' && k.length <= 300) out.toolOverrides[k] = v;
    }
  }
  return out;
}

function publicView(c, db, userId) {
  let hasKey = false;
  try { hasKey = !!getSecret(db, userId, vaultKeyFor(c.id)); } catch { hasKey = false; }
  return {
    id: c.id, provider: `custom:${c.id}`, catalogId: c.catalogId, name: c.name,
    baseURL: c.baseURL, allowPrivate: c.allowPrivate === true, enabled: c.enabled !== false, hasKey,
  };
}

/** The user's connections (key presence only, never the key). */
export function listConnections(userId, db = getDb()) {
  return read(db, userId).connections.map((c) => publicView(c, db, userId));
}

/** One connection by id (`cat-…`) or provider string (`custom:cat-…`), or undefined. */
export function getConnection(idOrProvider, userId, db = getDb()) {
  const id = String(idOrProvider || '').replace(/^custom:/, '');
  const c = read(db, userId).connections.find((x) => x.id === id);
  return c ? publicView(c, db, userId) : undefined;
}

export function getSettings(userId, db = getDb()) { return read(db, userId).settings; }

/** Merge a settings patch; unknown or invalid fields are ignored. Returns the stored settings. */
export function updateSettings(userId, patch, db = getDb()) {
  if (!userId) throw new Error('updateSettings requires a userId');
  const state = read(db, userId);
  const merged = { ...state.settings };
  if (typeof patch?.toolsEnabled === 'boolean') merged.toolsEnabled = patch.toolsEnabled;
  if (typeof patch?.fallbackEnabled === 'boolean') merged.fallbackEnabled = patch.fallbackEnabled;
  if (Array.isArray(patch?.fallbackOrder)) {
    // Only the user's own connections can be ordered; a stranger's id is dropped.
    const own = new Set(state.connections.map((c) => `custom:${c.id}`));
    merged.fallbackOrder = patch.fallbackOrder.filter((e) => own.has(e?.provider));
  }
  if (patch?.toolOverrides && typeof patch.toolOverrides === 'object') merged.toolOverrides = patch.toolOverrides;
  state.settings = normalizeSettings(merged);
  write(db, userId, state);
  return state.settings;
}

function validateKey(apiKey) {
  if (typeof apiKey !== 'string') return null;
  const k = apiKey.trim();
  if (!k) return null;
  if (k.length > 512 || /\s/.test(k)) throw Object.assign(new Error('That does not look like an API key (no spaces, at most 512 characters)'), { code: 'VALIDATION_FAILED' });
  return k;
}

/**
 * Connect (or update) a catalog provider for `userId`: validate the base URL,
 * put the key in the vault, record the connection. Throws an Error with a
 * `code` (VALIDATION_FAILED | NOT_FOUND | LIMIT) the route maps to a status.
 */
export function connectProvider(userId, { catalogId, apiKey, baseURL, slug, name, allowPrivate } = {}, db = getDb()) {
  if (!userId) throw new Error('connectProvider requires a userId');
  const entry = catalogEntry(catalogId);
  if (!entry) throw Object.assign(new Error(`Unknown catalog provider '${String(catalogId).slice(0, 40)}'`), { code: 'NOT_FOUND' });
  let id = `${ID_PREFIX}${entry.id}`;
  if (entry.customBaseURL) {
    const s = slug == null || slug === '' ? 'default' : String(slug).toLowerCase();
    if (!SLUG_RE.test(s)) throw Object.assign(new Error('slug must be 1-24 lowercase letters or digits'), { code: 'VALIDATION_FAILED' });
    id = `${id}-${s}`;
  }
  const state = read(db, userId);
  const existing = state.connections.find((c) => c.id === id);
  if (!existing && state.connections.length >= MAX_CONNECTIONS) {
    throw Object.assign(new Error(`At most ${MAX_CONNECTIONS} provider connections`), { code: 'LIMIT' });
  }
  const url = (typeof baseURL === 'string' && baseURL.trim()) ? baseURL.trim() : entry.baseURL;
  if (!url) throw Object.assign(new Error('This provider needs a base URL'), { code: 'VALIDATION_FAILED' });
  // A built-in hosted entry keeps its own URL: overriding it would let a key
  // be sent to a host the catalog never named.
  if (url !== entry.baseURL && !entry.customBaseURL && !entry.local) {
    throw Object.assign(new Error(`${entry.name} uses a fixed base URL; use the OpenAI-compatible entry for another host`), { code: 'VALIDATION_FAILED' });
  }
  const priv = entry.local ? true : (entry.allowPrivate === true && allowPrivate === true);
  let cleanUrl;
  try { cleanUrl = assertProviderBaseUrl(url, { allowPrivate: priv }); }
  catch (err) { throw Object.assign(new Error(err.message), { code: 'VALIDATION_FAILED' }); }
  const key = validateKey(apiKey);
  const vaultKey = vaultKeyFor(id);
  let hasKey = false;
  try { hasKey = !!getSecret(db, userId, vaultKey); } catch { hasKey = false; }
  if (!key && !hasKey && entry.keyRequired) {
    throw Object.assign(new Error(`${entry.name} needs an API key`), { code: 'VALIDATION_FAILED' });
  }
  if (key) setSecret(db, userId, vaultKey, key);
  else if (!hasKey) setSecret(db, userId, vaultKey, KEYLESS_PLACEHOLDER);
  const conn = {
    id, catalogId: entry.id,
    name: (typeof name === 'string' && name.trim() ? name.trim() : entry.name).slice(0, 100),
    baseURL: cleanUrl, allowPrivate: priv, enabled: true,
  };
  state.connections = [...state.connections.filter((c) => c.id !== id), conn];
  write(db, userId, state);
  return publicView(conn, db, userId);
}

/** Remove a connection, its vault key and its place in the fallback order. */
export function disconnectProvider(userId, idOrProvider, db = getDb()) {
  const id = String(idOrProvider || '').replace(/^custom:/, '');
  const state = read(db, userId);
  if (!state.connections.some((c) => c.id === id)) return false;
  state.connections = state.connections.filter((c) => c.id !== id);
  state.settings.fallbackOrder = state.settings.fallbackOrder.filter((e) => e.provider !== `custom:${id}`);
  write(db, userId, state);
  try { setSecret(db, userId, vaultKeyFor(id), ''); } catch { /* already gone */ }
  return true;
}

/**
 * A catalog connection in the shape custom-providers.mjs hands dispatch, so
 * `custom:cat-…` resolves through resolveCustomProviderDispatch unchanged.
 */
export function connectionAsCustomProvider(providerId, userId, db = getDb()) {
  if (typeof providerId !== 'string' || !providerId.startsWith(`custom:${ID_PREFIX}`)) return undefined;
  const c = read(db, userId).connections.find((x) => `custom:${x.id}` === providerId);
  if (!c) return undefined;
  return {
    id: c.id, name: c.name, baseURL: c.baseURL, vaultKey: vaultKeyFor(c.id), models: [],
    isOpenAICompatible: true, isEnabled: c.enabled !== false, anthropicBaseURL: null,
  };
}

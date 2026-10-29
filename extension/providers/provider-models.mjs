// Model listing and connection testing for provider-catalog connections.
//
// Live list where the provider offers one (`GET <base>/models`), cached for a
// few minutes per user and connection; the catalog's static table when there
// is no key, no network or an error. Every model carries its capability record
// (server/provider-catalog.mjs): tools supported, streaming, context window.
//
// The key rides only in the Authorization header of a request that refuses
// redirects, and every message that leaves this module is redacted with it.

import { getSecret } from '../server/vault.mjs';
import { getDb } from '../kb/db.mjs';
import { catalogEntry, isChatModel, modelCapability } from '../server/provider-catalog.mjs';
import { vaultKeyFor, getSettings } from '../server/provider-connections.mjs';
import { assertProviderBaseUrl, privateProvidersAllowed, joinBaseUrl } from '../server/base-url-guard.mjs';
import { makePinnedFetch, SsrfBlockedError } from '../server/pinned-fetch.mjs';
import { redactWithKey } from '../core/redact-secrets.mjs';

const TTL_MS = 10 * 60_000;
const MAX_CACHE = 200;
const cache = new Map();   // `${userId}|${id}` → { at, models }

/** Test seam. */
export function _clearModelCacheForTests() { cache.clear(); }

function parseList(entry, data) {
  const kind = entry.listKind;
  const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []));
  const out = [];
  for (const m of list) {
    const id = typeof m === 'string' ? m : (typeof m?.id === 'string' ? m.id : (typeof m?.name === 'string' ? m.name : ''));
    if (!id) continue;
    const live = {};
    if (kind === 'openrouter' && Array.isArray(m?.supported_parameters)) live.toolsSupported = m.supported_parameters.includes('tools');
    if (Number.isFinite(m?.context_length)) live.contextWindow = m.context_length;
    if (kind === 'together' && m?.type && m.type !== 'chat') continue;
    out.push({ id: id.replace(/^models\//, ''), live });
  }
  return out;
}

function authHeaders(apiKey) {
  // The keyless placeholder is not a credential; do not send it.
  return apiKey && apiKey !== 'not-required' ? { Authorization: `Bearer ${apiKey}` } : {};
}

// The base URL again, under the posture that is in force NOW (a connection made
// while the operator gate was open does not outlive it). Throws SSRF_BLOCKED.
function vetBase(conn) {
  try { assertProviderBaseUrl(conn.baseURL, { allowPrivate: conn.allowPrivate && privateProvidersAllowed() }); }
  catch (e) { throw new SsrfBlockedError(e.message); }
}

/**
 * Fetch and parse a connection's live model list. Throws (redacted) on failure.
 * @param {object} conn  a connection view (server/provider-connections.mjs)
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [opts]
 */
export async function fetchLiveModels(conn, apiKey, { fetchImpl, signal } = {}) {
  const entry = catalogEntry(conn.catalogId);
  if (!entry) throw new Error('unknown catalog provider');
  vetBase(conn);
  // Default: the pinned fetch (every resolved address classified, the checked one dialled).
  const doFetch = fetchImpl || makePinnedFetch({ allowPrivate: conn.allowPrivate });
  let res;
  try {
    res = await doFetch(joinBaseUrl(conn.baseURL, 'models'), {
      method: 'GET',
      headers: { ...authHeaders(apiKey), accept: 'application/json' },
      redirect: 'error',
      signal: signal || AbortSignal.timeout(15_000),
    });
  } catch (err) {
    if (err?.code === 'SSRF_BLOCKED') throw err;
    throw new Error(redactWithKey(`could not reach ${conn.name}: ${err?.cause?.code || err?.message || err}`, apiKey).slice(0, 200));
  }
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    const hint = res.status === 401 || res.status === 403 ? ' (the key was refused)' : '';
    throw Object.assign(new Error(redactWithKey(`${conn.name} answered HTTP ${res.status}${hint}${body ? `: ${body}` : ''}`, apiKey).slice(0, 300)), { status: res.status });
  }
  let data;
  try { data = await res.json(); } catch { throw new Error(`${conn.name} returned a model list that is not JSON`); }
  return parseList(entry, data);
}

/**
 * The models for one connection with capability flags.
 * @returns {Promise<{ models: object[], source: 'live'|'cache'|'static', detail?: string }>}
 */
export async function listConnectionModels(userId, conn, { refresh = false, fetchImpl, db = getDb() } = {}) {
  const entry = catalogEntry(conn.catalogId);
  if (!entry) return { models: [], source: 'static', detail: 'unknown catalog provider' };
  vetBase(conn);   // a refused target aborts, even when a cached list exists
  const overrides = getSettings(userId, db).toolOverrides;
  const shape = (list) => list
    .filter((m) => isChatModel(entry, m.id))
    .map((m) => modelCapability(entry, m.id, { live: m.live, override: overrides[`${conn.id}/${m.id}`] }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const fallback = (detail) => ({
    models: (entry.models || []).map((m) => modelCapability(entry, m.id, { override: overrides[`${conn.id}/${m.id}`] })),
    source: 'static', detail,
  });
  const ck = `${userId}|${conn.id}`;
  const hit = cache.get(ck);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return { models: shape(hit.raw), source: 'cache' };
  let apiKey = null;
  try { apiKey = getSecret(db, userId, vaultKeyFor(conn.id)); } catch { apiKey = null; }
  if (!apiKey && entry.keyRequired) return fallback('no API key configured');
  try {
    const raw = await fetchLiveModels(conn, apiKey, { fetchImpl });
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(ck, { at: Date.now(), raw });
    const models = shape(raw);
    return models.length ? { models, source: 'live' } : fallback('the provider listed no chat models');
  } catch (err) {
    // A guard refusal is never papered over with a static list: the caller aborts.
    if (err?.code === 'SSRF_BLOCKED') throw err;
    // A stale list beats a static one when the provider is briefly down.
    if (hit) return { models: shape(hit.raw), source: 'cache', detail: String(err?.message || err).slice(0, 200) };
    return fallback(String(err?.message || err).slice(0, 200));
  }
}

/**
 * Test a connection (a free GET /models, no tokens). Always resolves.
 * @returns {Promise<{ ok: boolean, detail: string, modelCount?: number }>}
 */
export async function testConnection(userId, conn, { fetchImpl, db = getDb() } = {}) {
  let apiKey = null;
  try { apiKey = getSecret(db, userId, vaultKeyFor(conn.id)); } catch { apiKey = null; }
  const entry = catalogEntry(conn.catalogId);
  if (!apiKey && entry?.keyRequired) return { ok: false, detail: 'no API key configured' };
  try {
    const raw = await fetchLiveModels(conn, apiKey, { fetchImpl });
    const n = raw.filter((m) => isChatModel(entry, m.id)).length;
    return { ok: true, detail: `connected, ${n} chat model${n === 1 ? '' : 's'} available`, modelCount: n };
  } catch (err) {
    return { ok: false, detail: redactWithKey(String(err?.message || err), apiKey).slice(0, 300) };
  }
}

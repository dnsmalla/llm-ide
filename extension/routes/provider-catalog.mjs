// Provider catalog routes (agent-kit K1 Phase 6):
//
//   GET  /kb/providers/catalog              catalog + this user's connections + settings
//   GET  /kb/providers/custom               the Claude-compatible (Anthropic Messages) endpoints: connections of kind 'anthropic-compatible' + the Mac-synced custom providers that have an Anthropic door (key presence only)
//   POST /kb/providers/catalog/connect      { catalogId, apiKey?, baseURL?, slug?, name?, allowPrivate? }
//   POST /kb/providers/catalog/disconnect   { id }
//   POST /kb/providers/catalog/test         { id }                (free GET /models)
//   POST /kb/providers/catalog/models       { id, refresh? }      (live list or static, with capability flags)
//   GET  /kb/providers/settings             { toolsEnabled, fallbackEnabled, fallbackOrder, toolOverrides }
//   PUT  /kb/providers/settings             a patch of the above
//   POST /kb/providers/turn                 SSE: a tool-capable turn on a connected non-Anthropic model
//
// Additive: the existing /kb/providers/verify and /kb/providers/models are
// untouched. A key is accepted in a request body once, goes straight to the
// per-user vault and is never returned, logged or put in an error.

import { getDb } from '../kb/db.mjs';
import { sendJSON, readBody, onClientDisconnect } from '../core/utils.mjs';
import { catalogEntries } from '../server/provider-catalog.mjs';
import {
  listConnections, getConnection, connectProvider, disconnectProvider, getSettings, updateSettings, kindOf,
} from '../server/provider-connections.mjs';
import { getSecret } from '../server/vault.mjs';
import { listCustomProviders } from '../server/custom-providers.mjs';
import { listConnectionModels, testConnection } from '../providers/provider-models.mjs';
import { runProviderTurn, ProviderTurnError } from '../llm_agent/adapter/provider-turn.mjs';
import { migrateLegacyProviderKeys, migrationView, legacyKeyFor } from '../providers/legacy-key-migration.mjs';
import { logger } from '../core/logger.mjs';
import { redactWithKey } from '../core/redact-secrets.mjs';

const log = logger.child({ component: 'provider-catalog-route' });
const STATUS_FOR = { VALIDATION_FAILED: 400, NOT_FOUND: 404, LIMIT: 409 };

function err(res, status, code, message) {
  sendJSON(res, status, { error: { code, message } });
}

async function body(req, res, limit = 64 * 1024) {
  let raw;
  try { raw = await readBody(req, limit); }
  catch (e) { err(res, 413, 'BODY_TOO_LARGE', e?.message || 'Request body too large'); return null; }
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; }
  catch { err(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); return null; }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function catalogView(userId, db) {
  const all = listConnections(userId, db);
  // The Claude-compatible entry is not part of this list (the Mac's Settings renders every entry as an OpenAI-form
  // provider): it is connected by id through /connect and listed by GET /kb/providers/custom.
  return catalogEntries().filter((e) => e.kind !== 'anthropic-compatible').map((e) => ({
    id: e.id, name: e.name, baseURL: e.baseURL, keyRequired: e.keyRequired, local: e.local === true,
    customBaseURL: e.customBaseURL === true, allowPrivate: e.allowPrivate === true,
    docsUrl: e.docsUrl || '', notes: e.notes || '',
    connections: all.filter((c) => c.catalogId === e.id),
  }));
}

/**
 * The user's Claude-compatible endpoints. `source: 'connection'` ones are managed here (connect with catalogId
 * 'anthropic-compatible', disconnect by id); `source: 'synced'` ones come from the Mac's custom-provider sync and are
 * listed read-only. Never a key: only `hasKey`.
 */
function listClaudeCompatible(userId, db) {
  const out = listConnections(userId, db)
    .filter((c) => kindOf(c.catalogId) === 'anthropic-compatible')
    .map((c) => ({ id: c.id, provider: c.provider, name: c.name, baseURL: c.baseURL, kind: 'anthropic-compatible', allowPrivate: c.allowPrivate, enabled: c.enabled, hasKey: c.hasKey, source: 'connection' }));
  for (const p of listCustomProviders(userId, db)) {
    if (!p.anthropicBaseURL) continue;
    let hasKey = false;
    try { hasKey = !!getSecret(db, userId, p.vaultKey); } catch { hasKey = false; }
    out.push({ id: p.id, provider: `custom:${p.id}`, name: p.name, baseURL: p.anthropicBaseURL, kind: 'anthropic-compatible', allowPrivate: false, enabled: p.isEnabled !== false, hasKey, source: 'synced' });
  }
  return out;
}

/**
 * @returns {Promise<boolean>} true when the request was handled
 */
export async function handleProviderCatalog(req, res, { userId, url }) {
  const path = url.split('?')[0];
  if (!path.startsWith('/kb/providers/')) return false;
  const db = getDb();
  const m = req.method;

  if (m === 'GET' && path === '/kb/providers/catalog') {
    // First use after the upgrade: carry the user's existing provider keys over (once, non-destructive).
    const migration = migrationView(migrateLegacyProviderKeys(userId, { db }));
    sendJSON(res, 200, { providers: catalogView(userId, db), settings: getSettings(userId, db), ...(migration ? { migration } : {}) });
    return true;
  }
  if (m === 'GET' && path === '/kb/providers/custom') {
    sendJSON(res, 200, { providers: listClaudeCompatible(userId, db) });
    return true;
  }
  if (m === 'GET' && path === '/kb/providers/settings') {
    sendJSON(res, 200, getSettings(userId, db));
    return true;
  }
  if (m === 'PUT' && path === '/kb/providers/settings') {
    const b = await body(req, res); if (!b) return true;
    sendJSON(res, 200, updateSettings(userId, b, db));
    return true;
  }
  if (m === 'POST' && path === '/kb/providers/catalog/connect') {
    const b = await body(req, res); if (!b) return true;
    try {
      // "Move to catalog": copy the key of a legacy provider the caller already has (never deleted, never returned).
      if (typeof b.apiKey !== 'string' && typeof b.copyKeyFrom === 'string') {
        const copied = legacyKeyFor(userId, b.copyKeyFrom, db);
        if (!copied) { err(res, 400, 'VALIDATION_FAILED', 'No stored key found for that provider'); return true; }
        b.apiKey = copied;
      }
      const connection = connectProvider(userId, b, db);
      sendJSON(res, 200, { ok: true, connection });
    } catch (e) {
      // The submitted key is redacted from whatever the error says, defensively.
      err(res, STATUS_FOR[e?.code] || 500, e?.code || 'INTERNAL', redactWithKey(String(e?.message || e), typeof b.apiKey === 'string' ? b.apiKey : null).slice(0, 300));
    }
    return true;
  }
  if (m === 'POST' && path === '/kb/providers/catalog/disconnect') {
    const b = await body(req, res); if (!b) return true;
    sendJSON(res, 200, { ok: true, removed: disconnectProvider(userId, String(b.id || ''), db) });
    return true;
  }
  if (m === 'POST' && (path === '/kb/providers/catalog/test' || path === '/kb/providers/catalog/models')) {
    const b = await body(req, res); if (!b) return true;
    const conn = getConnection(String(b.id || ''), userId, db);
    if (!conn) { err(res, 404, 'NOT_FOUND', 'That provider is not connected'); return true; }
    if (path.endsWith('/test')) sendJSON(res, 200, await testConnection(userId, conn, { db }));
    else {
      try { sendJSON(res, 200, await listConnectionModels(userId, conn, { refresh: b.refresh === true, db })); }
      catch (e) {
        // A refused address is an error, not a static list the UI would then trust.
        if (e?.code !== 'SSRF_BLOCKED') throw e;
        err(res, 403, 'PROVIDER_BLOCKED', String(e.message).slice(0, 300));
      }
    }
    return true;
  }
  if (m === 'POST' && path === '/kb/providers/turn') return handleTurn(req, res, userId, db);
  return false;
}

async function handleTurn(req, res, userId, db) {
  const b = await body(req, res, 1024 * 1024); if (!b) return true;
  const ac = new AbortController();
  onClientDisconnect(req, res, () => ac.abort());
  let streaming = false;
  const onEvent = (ev) => {
    if (res.writableEnded || ac.signal.aborted) return;
    if (!streaming) {
      streaming = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    }
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  try {
    await runProviderTurn({
      userId, provider: String(b.provider || ''), model: String(b.model || ''), message: b.message, history: b.history,
      mode: typeof b.mode === 'string' ? b.mode : 'ask',
      agentContext: b.agentContext && typeof b.agentContext === 'object' ? b.agentContext : {},
      onEvent, signal: ac.signal, deps: { db },
    });
  } catch (e) {
    if (e instanceof ProviderTurnError && !streaming) { err(res, e.status, e.code, e.message); return true; }
    log.error('provider_turn_failed', { code: e?.code, message: redactWithKey(String(e?.message || e), null).slice(0, 200) });
    if (!streaming) { err(res, 500, 'INTERNAL', 'The provider turn failed'); return true; }
    onEvent({ type: 'error', code: 'INTERNAL', message: 'The provider turn failed', retryable: false });
  }
  if (!res.writableEnded) res.end();
  return true;
}

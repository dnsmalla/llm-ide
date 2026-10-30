// A plain single-shot completion on a provider-catalog connection (`custom:cat-…`), through the
// multi-provider adapter: no tools, no loop, no session. It is what notes, summaries, plans and the
// Loop's checks use when the user chose a catalog model for background work (runClaude dispatches
// here for a catalog provider), so every request to a catalog host goes through the pinned fetch
// (server/pinned-fetch.mjs) exactly like a chat turn does.
//
// Errors are thrown in the shape completeViaApi threw them (`status`, `transient`) so the callers'
// retry and route-fallback logic is unchanged; a provider-config refusal carries
// code PROVIDER_UNAVAILABLE (the envelope /kb/complete and /code-assist map to a 400).

import { getDb } from '../kb/db.mjs';
import { recordUsage, flagQuota, recordRateLimits, noteUnmeteredModelCall } from '../kb/usage.mjs';
import { redactWithKey } from '../core/redact-secrets.mjs';
import { resolveCustomProviderDispatch } from './providers.mjs';
import { createChatModel, runToolTurn } from './adapter/index.mjs';
import { noteProviderRateLimited } from './provider-fallback.mjs';
import { RETRY_DELAYS_MS, sleep, jittered } from './backoff.mjs';
import { getConnection } from '../server/provider-connections.mjs';
import { catalogEntry } from '../server/provider-catalog.mjs';

const unavailable = (message) => Object.assign(new Error(message), { code: 'PROVIDER_UNAVAILABLE' });

/**
 * @param {string} provider  `custom:cat-…`
 * @param {object} o
 * @param {string} o.userId
 * @param {string} [o.model]  the catalog entry's first model when absent
 * @param {string} o.prompt
 * @param {number} [o.maxTokens]
 * @param {AbortSignal} [o.signal]
 * @param {{ userId?: string, endpoint?: string, requestId?: string }} [o.meter]
 * @param {object} [o.deps]  test seams: { db, modelFor, sleepImpl }
 * @returns {Promise<string>} the reply text
 */
export async function completeViaAdapter(provider, { userId, model, prompt, maxTokens = 8192, signal, meter, deps = {} } = {}) {
  const db = deps.db ?? getDb();
  const conn = userId ? getConnection(provider, userId, db) : null;
  if (!conn) throw unavailable(`Provider ${provider} is not connected. Add it in Settings, Providers.`);
  if (conn.enabled === false) throw unavailable(`${conn.name} is disabled. Enable it in Settings, Providers.`);
  const dispatch = resolveCustomProviderDispatch(provider, userId, db);
  if (dispatch.error) throw unavailable(dispatch.message);
  const modelId = (typeof model === 'string' && model.trim()) ? model.trim() : catalogEntry(conn.catalogId)?.models?.[0]?.id;
  if (!modelId) throw unavailable(`No model chosen for ${conn.name}. Pick one in Settings, Providers.`);

  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let failure = null;
    let text = '';
    let headers = null;
    let chatModel;
    try {
      chatModel = deps.modelFor
        ? deps.modelFor({ conn, apiKey: dispatch.apiKey, model: modelId })
        : createChatModel({
          name: conn.catalogId, baseURL: dispatch.baseUrl, apiKey: dispatch.apiKey, modelId,
          allowPrivate: conn.allowPrivate, fetchImpl: deps.fetchImpl, onHeaders: (h) => { headers = h; },
        });
    } catch (e) {
      // A refused address is final; it never retries or falls back to an unguarded path.
      throw Object.assign(new Error(redactWithKey(String(e?.message || e), dispatch.apiKey).slice(0, 300)), { code: e?.code === 'SSRF_BLOCKED' ? 'PROVIDER_BLOCKED' : undefined, transient: false });
    }
    const summary = await runToolTurn({
      model: chatModel, messages: [{ role: 'user', content: String(prompt) }], tools: [], maxOutputTokens: maxTokens,
      signal, apiKey: dispatch.apiKey,
      onEvent: (ev) => {
        if (ev.type === 'delta') text += ev.text || '';
        else if (ev.type === 'usage') {
          totals.inputTokens += ev.inputTokens; totals.outputTokens += ev.outputTokens;
          totals.cacheReadTokens += ev.cacheReadTokens; totals.cacheCreationTokens += ev.cacheCreationTokens;
        } else if (ev.type === 'error') failure = ev;
      },
    });
    // Metering never throws into a model call; a failed call that still spent tokens is metered too.
    if (meter?.userId || userId) {
      try {
        if (totals.inputTokens || totals.outputTokens) {
          recordUsage(db, { userId, provider, model: modelId, source: 'api', endpoint: meter?.endpoint, requestId: meter?.requestId, ...totals });
        }
        if (headers) recordRateLimits(userId, { provider, model: modelId, headers });
      } catch { /* best effort */ }
    } else noteUnmeteredModelCall();
    if (summary.ok && !failure) {
      const out = text.trim();
      if (!out) throw Object.assign(new Error('empty response from the provider'), { transient: false });
      return out;
    }
    const f = failure ?? { code: 'PROVIDER_ERROR', message: 'provider error', retryable: false };
    const err = Object.assign(new Error(f.message), {
      status: summary.failure?.status ?? undefined, transient: f.retryable === true, providerCode: f.code,
    });
    if (f.code === 'PROVIDER_RATE_LIMITED') { try { noteProviderRateLimited(userId, provider); } catch { /* advisory */ } }
    if (summary.failure?.quota) { try { flagQuota(db, userId, provider, modelId); } catch { /* advisory */ } }
    lastErr = err;
    if (!err.transient || signal?.aborted || attempt >= RETRY_DELAYS_MS.length) throw err;
    await (deps.sleepImpl ?? sleep)(jittered(RETRY_DELAYS_MS[attempt]));
  }
  throw lastErr;
}

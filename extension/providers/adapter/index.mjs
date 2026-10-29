// The multi-provider adapter: the ONE module that imports the Vercel AI SDK
// (`ai`, `@ai-sdk/openai-compatible`; enforced by eslint.config.mjs). Callers
// hand it plain data (a connection, messages, tools as JSON Schema + execute)
// and get back agent/v2 wire events through `onEvent`, so a turn on a
// non-Anthropic model looks like a Claude turn to every client.
//
// What it owns: building a chat model for an OpenAI-compatible endpoint with
// a fetch that refuses redirects and never leaves the connection's host (the
// key rides in Authorization), running the model/tool loop the library
// provides (bounded steps), and mapping the library's stream parts to our
// events. What it does NOT own: which tools exist, the permission gate, the
// system prompt, metering and fallback; those are the caller's
// (llm_agent/adapter/provider-turn.mjs), so a library swap touches this file.

import { streamText, tool, jsonSchema, stepCountIs } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { redactWithKey } from '../../core/redact-secrets.mjs';
import { assertProviderBaseUrl, privateProvidersAllowed } from '../../server/base-url-guard.mjs';
import { makePinnedFetch, SsrfBlockedError } from '../../server/pinned-fetch.mjs';

const MAX_TOOL_RESULT_CHARS = 20_000;
export const DEFAULT_MAX_STEPS = 12;

/**
 * A chat model for an OpenAI-compatible endpoint.
 * The default fetch is the pinned one (server/pinned-fetch.mjs): every resolved
 * address is classified and only a checked address is dialled. A refused
 * target throws SSRF_BLOCKED here or on the first request; the turn aborts.
 * @param {{ name: string, baseURL: string, apiKey?: string, modelId: string,
 *           allowPrivate?: boolean, fetchImpl?: typeof fetch }} o
 */
export function createChatModel({ name, baseURL, apiKey, modelId, allowPrivate = false, fetchImpl, onHeaders }) {
  if (typeof modelId !== 'string' || !modelId.trim()) throw new Error('No model id provided for this provider.');
  try { assertProviderBaseUrl(baseURL, { allowPrivate: allowPrivate && privateProvidersAllowed() }); }
  catch (e) { throw new SsrfBlockedError(e.message); }
  const doFetch = fetchImpl || makePinnedFetch({ allowPrivate });
  const origin = new URL(baseURL).origin;
  const guardedFetch = async (url, init = {}) => {
    // The library only ever calls <baseURL>/chat/completions; anything else
    // would carry the key to another host.
    if (new URL(String(url)).origin !== origin) throw new Error('adapter refused a request to a different host');
    const res = await doFetch(url, { ...init, redirect: 'error' });
    // Rate-limit headers go to the caller (learned limits); a failing hook never fails the request.
    if (onHeaders) { try { onHeaders(res.headers); } catch { /* observation only */ } }
    return res;
  };
  const provider = createOpenAICompatible({
    name: String(name || 'provider').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40) || 'provider',
    baseURL,
    ...(apiKey && apiKey !== 'not-required' ? { apiKey } : {}),
    fetch: guardedFetch,
  });
  return provider.chatModel(modelId);
}

/** Tools in our shape ({ name, description, parameters (JSON Schema), execute }) → the library's. */
export function toLibraryTools(tools = []) {
  const out = {};
  for (const t of tools) {
    out[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters || { type: 'object', properties: {} }),
      execute: async (input, { abortSignal, toolCallId } = {}) => t.execute(input, { signal: abortSignal, toolCallId }),
      // What the MODEL sees of a result (the UI event keeps the raw output): the
      // caller's framing, e.g. a data fence. Without one the library's default applies.
      ...(typeof t.toModelOutput === 'function'
        ? { toModelOutput: ({ output }) => ({ type: 'text', value: String(t.toModelOutput(output)) }) }
        : {}),
    });
  }
  return out;
}

function asText(output) {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && !Array.isArray(output)
      && typeof output.text === 'string' && Object.keys(output).length === 1) return output.text;
  try { return JSON.stringify(output) ?? ''; } catch { return String(output); }
}

function usageEvent(u) {
  return {
    type: 'usage',
    inputTokens: Number(u?.inputTokens) || 0, outputTokens: Number(u?.outputTokens) || 0,
    cacheReadTokens: Number(u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens) || 0,
    cacheCreationTokens: Number(u?.inputTokenDetails?.cacheWriteTokens) || 0,
  };
}

/**
 * Map one library stream part to zero or more agent/v2 events. Pure but for
 * `state` ({ open: Map<id, index>, next: number }), so tests can drive it.
 */
export function mapStreamPart(part, state, { apiKey } = {}) {
  switch (part?.type) {
    case 'text-delta':
      return typeof part.text === 'string' && part.text ? [{ type: 'delta', text: part.text }] : [];
    case 'tool-input-start': {
      const index = state.next++;
      state.open.set(part.id, index);
      return [{ type: 'tool_use_start', index, id: part.id ?? null, name: part.toolName ?? null }];
    }
    case 'tool-input-delta': {
      const index = state.open.get(part.id);
      return index == null ? [] : [{ type: 'tool_args_delta', index, partialJson: String(part.delta ?? '') }];
    }
    case 'tool-call': {
      // A provider that does not stream tool input gives the whole call at once.
      if (state.open.has(part.toolCallId)) return [];
      const index = state.next++;
      state.open.set(part.toolCallId, index);
      return [
        { type: 'tool_use_start', index, id: part.toolCallId ?? null, name: part.toolName ?? null },
        { type: 'tool_args_delta', index, partialJson: JSON.stringify(part.input ?? {}) },
      ];
    }
    case 'tool-result': {
      const text = asText(part.output);
      const isError = !!(part.output && typeof part.output === 'object' && part.output.error);
      return [{ type: 'tool_result', toolUseId: part.toolCallId ?? null, isError,
        text: text.slice(0, MAX_TOOL_RESULT_CHARS), truncated: text.length > MAX_TOOL_RESULT_CHARS }];
    }
    case 'tool-error':
      return [{ type: 'tool_result', toolUseId: part.toolCallId ?? null, isError: true,
        text: redactWithKey(String(part.error?.message ?? part.error ?? 'tool failed'), apiKey).slice(0, MAX_TOOL_RESULT_CHARS), truncated: false }];
    case 'finish-step':
      return [usageEvent(part.usage)];
    default:
      return [];
  }
}

/** Classify a library/provider error into our wire error (code, message, retryable). */
export function toWireError(err, { apiKey } = {}) {
  const status = Number(err?.statusCode ?? err?.status ?? err?.cause?.statusCode) || null;
  const raw = String(err?.message || err || 'provider error');
  const message = redactWithKey(raw, apiKey).slice(0, 400);
  if ([err, err?.cause, err?.lastError].some((e) => e?.code === 'SSRF_BLOCKED')) {
    return { code: 'PROVIDER_BLOCKED', message: 'The provider address was refused by the network guard.', retryable: false, status: null };
  }
  // A 429 that is about money or plan, not speed: retrying will not help today.
  const quota = status === 429 && /insufficient_quota|exceeded your current quota|billing|payment/i.test(raw);
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH', message: 'The provider refused the API key.', retryable: false, status };
  if (status === 429) return { code: 'PROVIDER_RATE_LIMITED', message: quota ? 'The provider says this account is out of quota.' : 'The provider rate-limited this request.', retryable: !quota, status, quota };
  if (status && status >= 500) return { code: 'PROVIDER_UNAVAILABLE', message: `The provider is unavailable (HTTP ${status}).`, retryable: true, status };
  if (err?.name === 'AbortError') return { code: 'ABORTED', message: 'The turn was cancelled.', retryable: false, status };
  return { code: 'PROVIDER_ERROR', message, retryable: false, status };
}

/**
 * Run one provider-backed turn: model, then tools, then model again, up to
 * `maxSteps`. Emits agent/v2 events; resolves with a summary; never throws for
 * a provider error (it emits `error` and resolves with `ok:false`).
 *
 * @param {object} o
 * @param {object} o.model     a chat model (createChatModel, or a mock in tests)
 * @param {string} [o.system]
 * @param {Array<{role:string, content:string}>} o.messages
 * @param {Array} [o.tools]    { name, description, parameters, execute }
 * @param {(ev: object) => void} o.onEvent
 * @param {AbortSignal} [o.signal]
 * @param {string} [o.apiKey]  only used to redact error text
 */
export async function runToolTurn({ model, system, messages, tools = [], maxSteps = DEFAULT_MAX_STEPS, maxOutputTokens, temperature, onEvent, signal, apiKey, maxBillableTokens }) {
  const started = Date.now();
  const state = { open: new Map(), next: 0 };
  const totals = { inputTokens: 0, outputTokens: 0 };
  let steps = 0;
  let finishReason = null;
  let ok = true;
  let text = '';
  let failure = null;   // { code, quota, status } of the error that ended the turn
  // Session cap (K1 P6b): what is left of the chat's billable tokens. Checked between model calls, so
  // the overshoot is bounded by one call; the stop is a clean end, not an error.
  const cap = Number.isSafeInteger(maxBillableTokens) && maxBillableTokens > 0 ? maxBillableTokens : 0;
  let capStop = false;
  const ctl = new AbortController();
  const relay = () => ctl.abort();
  if (signal?.aborted) ctl.abort(); else signal?.addEventListener?.('abort', relay, { once: true });
  try {
    const result = streamText({
      model, system, messages,
      ...(tools.length ? { tools: toLibraryTools(tools), stopWhen: stepCountIs(Math.max(1, maxSteps)) } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(temperature != null ? { temperature } : {}),
      abortSignal: ctl.signal,
      maxRetries: 0,   // retry/fallback policy is ours (fallback.mjs), never silent
      // The library's default is console.error(error), which prints the provider's
      // response body (it can echo the key). Errors reach us as the stream's
      // `error` part, redacted below.
      onError: () => {},
    });
    for await (const part of result.fullStream) {
      if (part.type === 'finish-step') {
        steps += 1; totals.inputTokens += part.usage?.inputTokens || 0; totals.outputTokens += part.usage?.outputTokens || 0;
        if (cap && !capStop && totals.inputTokens + totals.outputTokens >= cap) { capStop = true; ctl.abort(); }
      }
      if (part.type === 'text-delta') text += part.text || '';
      if (part.type === 'finish') finishReason = part.finishReason ?? null;
      if (part.type === 'error') {
        ok = false;
        const e = toWireError(part.error, { apiKey });
        failure = { code: e.code, status: e.status, quota: e.quota };
        onEvent({ type: 'error', code: e.code, message: e.message, retryable: e.retryable });
        continue;
      }
      if (part.type === 'abort') { if (!capStop || signal?.aborted) ok = false; continue; }
      for (const ev of mapStreamPart(part, state, { apiKey })) onEvent(ev);
    }
  } catch (err) {
    ok = false;
    const e = toWireError(err, { apiKey });
    failure = { code: e.code, status: e.status, quota: e.quota };
    onEvent({ type: 'error', code: e.code, message: e.message, retryable: e.retryable });
  }
  signal?.removeEventListener?.('abort', relay);
  if (capStop && !signal?.aborted) {
    ok = true; failure = null;
    onEvent({ type: 'delta', text: '\n\nStopped: this chat reached its session token limit (the limit is approximate to one reply). Raise the limit to continue.' });
    finishReason = 'session_cap';
  }
  if (ok) {
    onEvent({ type: 'result', subtype: finishReason === 'length' ? 'error_max_tokens' : 'success', costUsd: null,
      numTurns: steps, durationMs: Date.now() - started, sessionId: null, stopReason: finishReason });
  }
  return { ok, text, steps, finishReason, usage: totals, failure, capStop };
}

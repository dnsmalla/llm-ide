// Shared runtime for Phase-4 agents — Claude CLI wrapper, JSON
// extraction, and language directive.  Kept in its own module so
// planner/risk/code-sync don't each grow their own subtle copy.

import { execFile } from 'child_process';
import { getSecret } from '../server/vault.mjs';
import { getDb } from '../kb/db.mjs';
import { logger } from '../core/logger.mjs';
import { resolveProvider, providerApiKey, completeViaApi } from './providers.mjs';

const log = logger.child({ component: 'claude-runtime' });

const CLAUDE_TIMEOUT_MS = 90_000;        // 90 s per CLI attempt.  Planning
                                         // prompts are large but two retries
                                         // (270 s worst-case) still fit inside
                                         // the 3-minute /kb/summarize ceiling
                                         // and the Mac client's 5-minute task
                                         // group limit.  Previously 180 s meant
                                         // two calls could hit 6 min, outlasting
                                         // both the URLSession (240 s) and the
                                         // route timeout before the fix.
const DEFAULT_MODEL = process.env.LLMIDE_MODEL || 'claude-sonnet-4-6';
// Floor for the context-overflow retry: halving the output budget below
// this produces summaries/answers too truncated to be useful, so we
// stop retrying and surface the error instead.
const MIN_OVERFLOW_TOKENS = 256;
// Anthropic API version header.  2023-06-01 is the current stable
// version; overridable so a future version bump is a config change,
// not a deploy.  Prompt caching is GA on this version — the old
// `anthropic-beta: prompt-caching-2024-07-31` header is no longer
// needed and has been dropped.
const ANTHROPIC_VERSION = process.env.LLMIDE_ANTHROPIC_VERSION || '2023-06-01';

// Caller-supplied model ids reach us straight from the client's picker,
// which can also offer non-Anthropic options (Cursor/Copilot/Gemini) that
// would 404 against the Anthropic API. Accept only well-formed Claude ids;
// anything else (empty, stale, or a foreign provider) falls back to the
// default rather than failing the request. A regex (not a fixed list)
// keeps new Claude models working without a code change here.
const CLAUDE_MODEL_RE = /^claude-[a-z0-9.\-]+$/;
function resolveModel(model) {
  return (typeof model === 'string' && CLAUDE_MODEL_RE.test(model)) ? model : DEFAULT_MODEL;
}

// Anthropic 529 "overloaded" responses usually clear within 5-30s.
// Retry transient capacity errors (529, 503) with jittered backoff
// before bubbling up to the user. Other errors (auth, 4xx, malformed
// JSON) throw on first attempt — masking those would hide real bugs.
const RETRY_DELAYS_MS = [1_000, 3_000];  // attempt 1 → 2 (after 1s),
                                          // attempt 2 → 3 (after 3s).
                                          // 3 attempts total.

// ±25% jitter to avoid thundering-herd retries from concurrent calls.
// Exported — the dispatcher's retry backoff uses the same strategy.
export function jittered(ms) {
  const factor = 0.75 + Math.random() * 0.5;
  return Math.round(ms * factor);
}

function isCliOverloaded(stderr) {
  if (typeof stderr !== 'string') return false;
  return /\b529\b|\boverloaded\b|\b503\b|\bservice unavailable\b/i.test(stderr);
}

// Redact the in-flight API key from any text before it is surfaced in an
// error message or written to stderr/logs. The Claude CLI and the
// Anthropic HTTP API can echo the key (e.g. "invalid x-api-key: sk-ant-…")
// in their diagnostics; without this a user-scoped key could leak into the
// server logs or be returned to a client in an error envelope. Also masks
// any other sk-ant-* token that happens to appear.
function redactKey(text, apiKey) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  if (apiKey) out = out.split(apiKey).join('***');
  return out.replace(/sk-ant-[A-Za-z0-9-]{10,}/g, 'sk-ant-***');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Hard cap on prompt length passed to either the HTTP API or the
// CLI.  Server-level /generate-* routes also cap their inputs at
// ~500 k chars, but agent modules (planner, risk, meeting-agent,
// codegen) build their own prompts from KB context + transcript and
// previously had no cap — a hostile transcript could feed an
// unbounded prompt to execFile('claude', ['-p', prompt]) and exhaust
// the ARG_MAX / pipe buffer.  Keep the cap aligned with the server.
const MAX_PROMPT_CHARS = 500_000;

// Run Claude CLI with the caller's prompt.  The `userId` argument is
// optional — when provided we look up the user's stored
// `claude.apiKey` from the vault and inject it as ANTHROPIC_API_KEY,
// so multi-user deployments charge each user's own Anthropic account
// rather than the operator's CLI login.  When userId is omitted (or
// the user has no stored key) we fall back to the operator's CLI auth.
export async function runClaude(prompt, { userId, model, maxTokens, cacheTranscript } = {}) {
  if (typeof prompt !== 'string') {
    throw new Error('runClaude: prompt must be a string');
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`runClaude: prompt too long (${prompt.length} > ${MAX_PROMPT_CHARS} chars)`);
  }
  // Allow callers to pass a tighter max_tokens budget.
  // Meeting-agent question drafts only need ~512 tokens; using 8192
  // for every call over-spends on short structured outputs.
  // Default: 8192 (safe for planning, long-form agent replies).
  const resolvedMaxTokens = (Number.isFinite(maxTokens) && maxTokens > 0) ? maxTokens : 8192;

  // Multi-provider routing: a non-Anthropic model (OpenAI/Google) goes to
  // its HTTP adapter. Anthropic keeps the hardened path below (prompt
  // caching, context-overflow retry, operator CLI fallback).
  const provider = resolveProvider(model);
  if (provider !== 'anthropic') {
    const key = providerApiKey(userId, provider);
    if (!key) {
      throw new Error(`No API key configured for ${provider}. Add one in Settings, or choose a Claude model.`);
    }
    return completeViaApi(provider, { apiKey: key, model, prompt, maxTokens: resolvedMaxTokens });
  }

  // A user-scoped key is one stored against this specific userId in the
  // vault.  When such a key is in play, the caller's intent is "bill
  // and quota against THIS user's Anthropic account" — silently
  // falling back to the operator CLI on HTTP failure would (a) charge
  // the wrong account and (b) sidestep the user's own quota/rate
  // limits.  Per-process ANTHROPIC_API_KEY is treated as operator
  // default and is allowed to fall back to the CLI like before.
  const userScopedKey = userId ? safeLookupApiKey(userId) : null;
  const apiKey = userScopedKey || process.env.ANTHROPIC_API_KEY;
  const resolvedModel = resolveModel(model);

  if (apiKey) {
    // Build the messages array. When cacheTranscript is true, use
    // Anthropic's prompt caching: mark the large transcript block
    // with cache_control so repeated calls (notes → chat → re-generate)
    // reuse the cached tokenization. This cuts input token cost by
    // ~90% and reduces TTFT by 1-3s on long transcripts.
    // Prompt caching requires the content to be structured as an array
    // of content blocks (not a plain string).
    let messages;
    if (cacheTranscript && prompt.includes('<<<BEGIN>>>')) {
      const splitIdx = prompt.indexOf('<<<BEGIN>>>');
      const systemPart = prompt.slice(0, splitIdx);
      const transcriptPart = prompt.slice(splitIdx);
      messages = [{ role: 'user', content: [
        { type: 'text', text: systemPart },
        { type: 'text', text: transcriptPart, cache_control: { type: 'ephemeral' } },
      ]}];
    } else {
      messages = [{ role: 'user', content: prompt }];
    }

    // HTTP path with backoff on transient 529/503.
    // attemptMaxTokens can be lowered mid-flight: a 400 caused by
    // input + max_tokens exceeding the context window is retried once
    // with a halved output budget (see overflow handling below).
    let attemptMaxTokens = resolvedMaxTokens;
    let overflowRetried = false;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: resolvedModel,
            max_tokens: attemptMaxTokens,
            messages,
          }),
          // Hard ceiling on a single HTTP attempt — without this the
          // fetch can hang indefinitely if Anthropic's edge stalls,
          // leaking the request socket and blocking the agent loop.
          // AbortError surfaces in the catch below and is funnelled
          // through the same retry path as a transient 529/503.
          signal: AbortSignal.timeout(60_000)
        });

        if (response.ok) {
          const data = await response.json();
          if (data.content && data.content.length > 0) {
            // Structured usage line so operators can track token spend
            // and spot prompts creeping toward the context window.
            if (data.usage) {
              log.info('runClaude usage', {
                model: resolvedModel,
                inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens,
                cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
              });
            }
            return data.content[0].text;
          }
          if (userScopedKey) {
            throw new Error('Anthropic API returned empty content for user-scoped key');
          }
          // Empty content on HTTP 200 is abnormal (stop_reason quirk or
          // extreme context pressure) — log loudly before the CLI
          // fallback so the condition is visible, not silent.
          log.warn('runClaude HTTP 200 with empty content, falling back to CLI', { model: resolvedModel, stopReason: data.stop_reason ?? null });
          break; // fall through to CLI for operator default
        }

        const transient = response.status === 529 || response.status === 503;
        if (transient && attempt < RETRY_DELAYS_MS.length) {
          const delay = jittered(RETRY_DELAYS_MS[attempt]);
          log.warn('runClaude retry', { attempt: attempt + 1, status: response.status, delayMs: delay });
          await sleep(delay);
          continue;
        }

        // 400s carry an explanation in the body. Two cases deserve
        // dedicated handling instead of a generic failure:
        //   - context overflow where max_tokens + input exceeds the
        //     window → retry once with a halved output budget;
        //   - model not found (retired/typo'd model id) → name the
        //     configured model in the error so the operator can fix
        //     LLMIDE_MODEL instead of chasing a generic 400.
        if (response.status === 400 || response.status === 404) {
          let bodyText = '';
          try { bodyText = (await response.text()).slice(0, 500); } catch { /* ignore */ }
          const overflow = /max_tokens|too long|context/i.test(bodyText);
          if (overflow && !overflowRetried && attemptMaxTokens > MIN_OVERFLOW_TOKENS) {
            overflowRetried = true;
            attemptMaxTokens = Math.max(MIN_OVERFLOW_TOKENS, Math.floor(attemptMaxTokens / 2));
            log.warn('runClaude context overflow, retrying with reduced max_tokens', { maxTokens: attemptMaxTokens });
            continue;
          }
          const modelRejected = /model/i.test(bodyText) && /not found|invalid|unknown|deprecat/i.test(bodyText);
          if (userScopedKey) {
            throw new Error(modelRejected
              ? `Anthropic API rejected model '${resolvedModel}' (${response.status}): ${redactKey(bodyText.slice(0, 200), apiKey)} — check LLMIDE_MODEL`
              : `Anthropic API failed (${response.status}) for user-scoped key: ${redactKey(bodyText.slice(0, 200), apiKey)}`);
          }
          const logFields = { status: response.status, detail: redactKey(bodyText.slice(0, 200), apiKey) };
          if (modelRejected) {
            log.error(`runClaude model '${resolvedModel}' rejected by API — check LLMIDE_MODEL; falling back to CLI`, logFields);
          } else {
            log.warn('runClaude HTTP API failed, falling back to CLI', logFields);
          }
          break;
        }

        if (userScopedKey) {
          let detail = '';
          try { detail = redactKey((await response.text()).slice(0, 200), apiKey); } catch { /* ignore */ }
          throw new Error(`Anthropic API failed (${response.status}) for user-scoped key${detail ? `: ${detail}` : ''}`);
        }
        log.warn('runClaude HTTP API failed, falling back to CLI', { status: response.status });
        break;
      } catch (err) {
        // AbortSignal.timeout fires a DOMException named 'TimeoutError'
        // (also surfaced as AbortError in some runtimes). Treat the
        // 60 s ceiling as a transient failure and retry with backoff,
        // matching the 529/503 path above.
        const isAbort = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (isAbort && attempt < RETRY_DELAYS_MS.length) {
          const delay = jittered(RETRY_DELAYS_MS[attempt]);
          log.warn('runClaude retry', { attempt: attempt + 1, reason: 'abort', delayMs: delay });
          await sleep(delay);
          continue;
        }
        if (userScopedKey) {
          throw err;
        }
        log.warn('runClaude HTTP API threw error, falling back to CLI', { error: redactKey(err.message, apiKey) });
        break;
      }
    }
  }

  // CLI path with backoff on stderr-detected overload.
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        // Pass a minimal allowlist rather than spreading all of
        // process.env.  Spreading the full env exposes every secret
        // the server was started with (JWT_SECRET, LLMIDE_VAULT_KEY,
        // DB path, etc.) to the Claude CLI subprocess and any logging
        // it performs.  Claude CLI needs PATH + HOME to locate configs
        // and optional helper binaries; everything else is application
        // state that the subprocess has no business seeing.
        const env = {
          PATH:                   process.env.PATH             || '',
          HOME:                   process.env.HOME             || '',
          TMPDIR:                 process.env.TMPDIR           || '',
          TMP:                    process.env.TMP              || '',
          TEMP:                   process.env.TEMP             || '',
          USER:                   process.env.USER             || '',
          LOGNAME:                process.env.LOGNAME          || '',
          SHELL:                  process.env.SHELL            || '',
          TERM:                   process.env.TERM             || '',
          LANG:                   process.env.LANG             || '',
          LC_ALL:                 process.env.LC_ALL           || '',
          NODE_ENV:               process.env.NODE_ENV         || '',
          ANTHROPIC_BASE_URL:     process.env.ANTHROPIC_BASE_URL || '',
          // Claude Code needs XDG / AppData dirs for its own config.
          XDG_CONFIG_HOME:        process.env.XDG_CONFIG_HOME  || '',
          XDG_DATA_HOME:          process.env.XDG_DATA_HOME    || '',
          APPDATA:                process.env.APPDATA          || '',
          USERPROFILE:            process.env.USERPROFILE      || '',
        };
        if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
        // Remove empty-string entries so the subprocess env is clean.
        for (const k of Object.keys(env)) if (!env[k]) delete env[k];
        execFile('claude', ['-p', prompt], {
          timeout: CLAUDE_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          env,
        }, (error, stdout, stderr) => {
          if (error) {
            if (error.code === 'ENOENT') {
              reject(new Error('Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code'));
              return;
            }
            const e = new Error(`Claude error: ${redactKey(stderr?.slice(0, 200) || error.message, apiKey)}`);
            e.overloaded = isCliOverloaded(stderr) || isCliOverloaded(stdout);
            reject(e);
            return;
          }
          resolve(stdout);
        });
      });
    } catch (err) {
      lastError = err;
      if (err.overloaded && attempt < RETRY_DELAYS_MS.length) {
        const delay = jittered(RETRY_DELAYS_MS[attempt]);
        log.warn('runClaude CLI retry', { attempt: attempt + 1, reason: 'overloaded', delayMs: delay });
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Streaming variant of runClaude. Calls `onChunk(text)` for each text
 * delta as it arrives from the Anthropic API. Returns the full
 * concatenated text when done.
 *
 * Falls back gracefully:
 *   - No API key → CLI (buffered, single onChunk at end)
 *   - Transient 529/503 → one retry, then CLI fallback
 *   - Non-transient API error → CLI fallback (operator key only)
 *   - `signal` aborted → reader cancelled, partial text returned
 */
export async function runClaudeStream(prompt, { userId, model, maxTokens, cacheTranscript, onChunk, signal } = {}) {
  if (typeof onChunk !== 'function') {
    return runClaude(prompt, { userId, model, maxTokens, cacheTranscript });
  }
  if (typeof prompt !== 'string') throw new Error('runClaudeStream: prompt must be a string');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`runClaudeStream: prompt too long`);

  const resolvedMaxTokens = (Number.isFinite(maxTokens) && maxTokens > 0) ? maxTokens : 8192;
  const userScopedKey = userId ? safeLookupApiKey(userId) : null;
  const apiKey = userScopedKey || process.env.ANTHROPIC_API_KEY;
  const resolvedModel = resolveModel(model);

  // Helper: buffered fallback via runClaude. Delivers the entire result
  // as a single chunk so the caller still gets onChunk() called.
  const fallbackBuffered = async () => {
    const result = await runClaude(prompt, { userId, model, maxTokens, cacheTranscript });
    onChunk(result);
    return result;
  };

  // Non-Anthropic models have no streaming adapter yet — route them
  // through the buffered path (runClaude → provider HTTP), delivered as a
  // single chunk. Without this, the streaming code below would send a
  // non-Claude id to the Anthropic API (coerced to the default model).
  if (resolveProvider(model) !== 'anthropic') return fallbackBuffered();

  if (!apiKey) return fallbackBuffered();

  // Build messages (same caching logic as runClaude).
  let messages;
  if (cacheTranscript && prompt.includes('<<<BEGIN>>>')) {
    const splitIdx = prompt.indexOf('<<<BEGIN>>>');
    const systemPart = prompt.slice(0, splitIdx);
    const transcriptPart = prompt.slice(splitIdx);
    messages = [{ role: 'user', content: [
      { type: 'text', text: systemPart },
      { type: 'text', text: transcriptPart, cache_control: { type: 'ephemeral' } },
    ]}];
  } else {
    messages = [{ role: 'user', content: prompt }];
  }

  // Retry once on transient 529/503, then fall back to buffered.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: resolvedModel,
          max_tokens: resolvedMaxTokens,
          stream: true,
          messages,
        }),
        signal: signal || AbortSignal.timeout(90_000),
      });
    } catch (err) {
      // Network error or abort — fall back to buffered.
      if (userScopedKey) throw err;
      log.warn('runClaudeStream fetch threw, falling back to buffered', { error: err?.message });
      return fallbackBuffered();
    }

    if (response.ok) {
      // Success — read the SSE stream.
      return _readAnthropicStream(response, onChunk, signal);
    }

    const transient = response.status === 529 || response.status === 503;
    if (transient && attempt === 0) {
      const delay = jittered(2_000);
      log.warn('runClaudeStream retry', { status: response.status, delayMs: delay });
      await sleep(delay);
      continue;
    }

    // Non-transient or second failure.
    let detail = '';
    try { detail = redactKey((await response.text()).slice(0, 300), apiKey); } catch { /* */ }
    // Context overflow: the buffered path can recover (runClaude retries
    // with a halved output budget), so route BOTH key types through it
    // instead of failing the stream. The user key stays in play —
    // fallbackBuffered passes the same userId through to runClaude.
    if (response.status === 400 && /max_tokens|too long|context/i.test(detail)) {
      log.warn('runClaudeStream context overflow, retrying via buffered path', { status: response.status });
      return fallbackBuffered();
    }
    if (userScopedKey) {
      throw new Error(`Anthropic streaming failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    log.warn('runClaudeStream API failed, falling back to buffered', { status: response.status });
    return fallbackBuffered();
  }

  // Should not reach here, but just in case.
  return fallbackBuffered();
}

/** Parse an Anthropic SSE stream and call onChunk for each text delta. */
async function _readAnthropicStream(response, onChunk, signal) {
  let fullText = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // If the caller's signal fires, cancel the reader so we stop
  // consuming tokens from the Anthropic API.
  const onAbort = () => {
    reader.cancel().catch((err) => {
      // A failed cancel can leak the socket — surface it instead of
      // swallowing so FD-exhaustion shows up in logs.
      log.warn('runClaudeStream reader cancel failed', { error: err?.message });
    });
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        if (!event.trim()) continue;
        const dataLine = event.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const jsonStr = dataLine.slice(6);
        if (jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text;
            onChunk(parsed.delta.text);
          }
          // Anthropic sends an error event when something goes wrong
          // mid-stream (e.g. context window exceeded).
          if (parsed.type === 'error') {
            throw new Error(`Anthropic stream error: ${parsed.error?.message || JSON.stringify(parsed.error)}`);
          }
        } catch (e) {
          // Propagate real errors; skip JSON parse failures.
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (!fullText) {
    throw new Error('Anthropic streaming returned no content');
  }
  return fullText;
}

function safeLookupApiKey(userId) {
  try {
    return getSecret(getDb(), userId, 'claude.apiKey');
  } catch {
    return null;
  }
}

export function tryParseJSON(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  const firstBracket = s.indexOf('[');
  const lastBracket = s.lastIndexOf(']');
  // Pick whichever delimiter pair encloses more content — handles both
  // top-level objects and arrays without a separate code path.
  const objSpan = first !== -1 && lastBrace > first ? lastBrace - first : -1;
  const arrSpan = firstBracket !== -1 && lastBracket > firstBracket ? lastBracket - firstBracket : -1;
  if (objSpan < 0 && arrSpan < 0) return null;
  const slice = arrSpan > objSpan
    ? s.slice(firstBracket, lastBracket + 1)
    : s.slice(first, lastBrace + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

const LANGUAGE_NAMES = {
  ja: 'Japanese', en: 'English', 'en-US': 'English', 'en-GB': 'English',
  'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
  ko: 'Korean', hi: 'Hindi', 'ne-NP': 'Nepali',
  es: 'Spanish', fr: 'French', de: 'German',
  'pt-BR': 'Brazilian Portuguese', it: 'Italian', ru: 'Russian',
  ar: 'Arabic', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian',
  ms: 'Malay', tl: 'Filipino',
};

export function languageDirective(code) {
  if (typeof code !== 'string') return { name: null, line: '' };
  const name = LANGUAGE_NAMES[code] || LANGUAGE_NAMES[code.split('-')[0]] || null;
  if (!name) return { name: null, line: '' };
  return {
    name,
    line: `Write all string VALUES (titles, descriptions, owner, riskReason, etc.) in ${name}. JSON KEYS stay exactly as shown. Do not translate code identifiers, file paths, or quotes from the transcript.`,
  };
}

/// Prose-shaped variant of `languageDirective` for endpoints whose
/// LLM output is markdown / freeform text instead of JSON.  Same
/// LANGUAGE_NAMES table; the directive sentence is what differs.
/// Used by /generate-notes, /chat, /generate-questions, etc.
export function resolveLanguage(raw) {
  if (typeof raw !== 'string') return { name: null, directive: '' };
  const code = raw.trim();
  if (!code) return { name: null, directive: '' };
  const name = LANGUAGE_NAMES[code] || LANGUAGE_NAMES[code.split('-')[0]] || null;
  if (!name) return { name: null, directive: '' };
  return {
    name,
    directive: `Write your entire response in ${name}. All headings, bullet points, proper names transliterated as needed, and examples must be in ${name}. Do not translate the transcript itself; quote it verbatim where quoting.`,
  };
}

// Compact a KB context block down to a budget so the prompt stays under
// Claude's effective context.  Each row contributes its title + the
// first ~200 chars of body.  Rows are presented as a markdown bullet
// list with a kind tag — the LLM can reference them by index.
export function formatContext(label, rows, perRow = 200, max = 8) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const trimmed = rows.slice(0, max).map((r, i) => {
    const body = (r.body || '').replace(/\s+/g, ' ').slice(0, perRow);
    const title = (r.title || '').replace(/\s+/g, ' ').slice(0, 200);
    return `  ${i + 1}. [${r.kind}] ${title}${body ? ` — ${body}` : ''}`;
  });
  return `### ${label}\n${trimmed.join('\n')}\n`;
}

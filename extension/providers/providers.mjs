// Multi-provider model routing.
//
// `providers/runtime.mjs` keeps the hardened Anthropic HTTP + CLI path. This
// module adds the model→provider routing plus OpenAI and Google HTTP
// adapters so the same agent prompts can run against whichever provider a
// user has configured. Credentials per provider come from the vault
// (`<provider>.apiKey`) with an operator env fallback; when no key is set
// the caller can fall back to that provider's locally-logged-in CLI
// ("subscription mode" — same auth the claude/codex/gemini CLIs use).

import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { lookup } from 'node:dns/promises';
import { getSecret } from '../server/vault.mjs';
import { getCustomProvider } from '../server/custom-providers.mjs';
import { getDb } from '../kb/db.mjs';
import { logger } from '../core/logger.mjs';
import { RETRY_DELAYS_MS, sleep, jittered } from './backoff.mjs';
import { Semaphore } from '../core/semaphore.mjs';
import { recordUsage, flagQuota, recordRateLimits, resolveModel as resolveUsageModel } from '../kb/usage.mjs';
import { recordActivity } from '../kb/activity.mjs';
import { redactWithKey } from '../core/redact-secrets.mjs';

// Throttle fallback activity events to one per (user, provider, fromModel) per
// 10 min, so a sustained quota-exhaustion loop doesn't flood the feed.
const _fallbackNotified = new Map();
function shouldNotifyFallback(userId, provider, fromModel) {
  const key = `${userId}::${provider}::${fromModel}`;
  const now = Date.now();
  const last = _fallbackNotified.get(key) || 0;
  if (now - last < 10 * 60_000) return false;
  _fallbackNotified.set(key, now);
  return true;
}

const log = logger.child({ component: 'providers' });

// Per-provider config: vault key name, operator env fallback, and the CLI
// binary used for subscription (no-key) mode.
export const PROVIDERS = {
  anthropic: { vaultKey: 'claude.apiKey',    env: 'ANTHROPIC_API_KEY',   cli: 'claude' },
  openai:    { vaultKey: 'openai.apiKey',    env: 'OPENAI_API_KEY',      cli: 'codex'  },
  google:    { vaultKey: 'google.apiKey',    env: 'GOOGLE_API_KEY',      cli: 'gemini' },
  deepseek:  { vaultKey: 'deepseek.apiKey',  env: 'DEEPSEEK_API_KEY',    cli: null     },
  glm:       { vaultKey: 'glm.apiKey',       env: 'GLM_API_KEY',         cli: null     },
  // Generic OpenAI-compatible endpoint — covers OpenRouter, Ollama/LM Studio
  // (local), Mistral, Together, etc. The base URL is user-supplied
  // (vault `custom.baseUrl`); it is NOT id-prefix routable, so callers must
  // select it explicitly (the picker passes provider="custom").
  custom:    { vaultKey: 'custom.apiKey',    env: 'OPENAI_COMPAT_API_KEY', cli: null  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
// DeepSeek's API root. Exported because the same literal was otherwise
// re-typed at every call site (runtime.mjs's completeViaApi call,
// llm_agent/runtime/route.mjs's native-loop base) — one of which is how this
// constant ended up declared-but-unused in the first place.
export const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com';

// ── SSRF guard ────────────────────────────────────────────────────────
//
// Custom base URLs are user-supplied and must not be forwarded to
// internal/private addresses. We require HTTPS and block:
//   • loopback:    127.0.0.0/8, ::1, localhost
//   • link-local:  169.254.0.0/16, fe80::/10
//   • RFC-1918:    10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16

// Matches private/loopback IPv4 addresses that must never be reachable via a custom base URL.
const PRIVATE_IPv4_RE = /^(127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|169\.254(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|192\.168(\.\d{1,3}){2})$/;

// Normalise an IPv6 address for comparison (strip brackets, lowercase).
function normaliseIPv6(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1).toLowerCase() : host.toLowerCase();
}

function isPrivateIPv6(host) {
  const h = normaliseIPv6(host);
  if (h === '::1') return true;                       // loopback
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;    // fe80::/10 link-local
  return false;
}

/**
 * Throw a clear Error if `url` is not safe to use as a provider base URL.
 * Rules: must be https:, hostname must not be localhost, a loopback address,
 * an RFC-1918 address, or a link-local address.
 */
export function assertSafeBaseUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch {
    throw new Error(`SSRF guard: invalid base URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`SSRF guard: base URL must use https: (got ${parsed.protocol})`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost') {
    throw new Error('SSRF guard: base URL hostname must not be localhost');
  }
  if (PRIVATE_IPv4_RE.test(hostname)) {
    throw new Error(`SSRF guard: base URL resolves to a private/loopback IPv4 address (${hostname})`);
  }
  if (isPrivateIPv6(hostname)) {
    throw new Error(`SSRF guard: base URL resolves to a private/loopback IPv6 address (${hostname})`);
  }
}

/**
 * Full SSRF guard for a base URL that is about to be fetched: the synchronous
 * literal checks above PLUS a DNS-resolution check that rejects a hostname
 * whose A/AAAA record points at a private/loopback/link-local address (the
 * "domain → internal IP" attack the literal regex can't catch). Call this at
 * EVERY network entry point, not just the vault setter — the verify route
 * forwards a raw, user-supplied baseUrl straight to fetch.
 *
 * Residual: this doesn't pin the connection to the validated IP, so a rebind
 * between this lookup and fetch's own resolution isn't fully closed; it does
 * block the practical static-resolution case. Full pinning would need a custom
 * agent/socket (cf. email-source.mjs resolveSafeHost).
 */
export async function assertSafeBaseUrlResolved(url) {
  assertSafeBaseUrl(url);                          // protocol + literal-IP checks
  const { hostname } = new URL(url);
  let addrs;
  try { addrs = await lookup(hostname, { all: true }); }
  catch { return; }                                // unresolvable → fetch will error; not an SSRF path
  for (const { address } of addrs) {
    const addr = String(address).toLowerCase();
    if (addr === '127.0.0.1' || addr === '::1'
        || PRIVATE_IPv4_RE.test(addr) || isPrivateIPv6(addr)) {
      throw new Error(`SSRF guard: base URL host ${hostname} resolves to a private/loopback address (${address})`);
    }
  }
}

// Base URL for the custom OpenAI-compatible provider: user's vault value
// first, then an operator env fallback. Trailing slashes stripped. null when
// unset (the caller then reports "configure a base URL").
// Always validated against the SSRF guard before returning.
export function customBaseUrl(userId) {
  let url = null;
  if (userId) {
    try { url = getSecret(getDb(), userId, 'custom.baseUrl') || null; } catch { url = null; }
  }
  url = url || process.env.LLMIDE_OPENAI_COMPAT_BASE_URL || null;
  if (!url) return null;
  const stripped = url.replace(/\/+$/, '');
  assertSafeBaseUrl(stripped);
  return stripped;
}

// Map a model id to its provider. A regex per family (not a fixed list)
// keeps new models working without a code change here. Unknown / blank →
// anthropic, the historical default.
export function resolveProvider(model) {
  const m = typeof model === 'string' ? model.trim().toLowerCase() : '';
  // Custom provider ID format: custom:uuid
  if (/^custom:/.test(m)) return m;
  if (/^claude[-/]/.test(m)) return 'anthropic';
  if (/^(gpt[-_]|o\d|chatgpt|codex|text-davinci)/.test(m)) return 'openai';
  if (/^(gemini[-/]|models\/gemini)/.test(m)) return 'google';
  if (/^deepseek[-/]/.test(m)) return 'deepseek';
  return 'anthropic';
}

// API key for a provider: the user's own vault key first (so spend/quota
// bills their account), then the operator env fallback. Never throws.
export function providerApiKey(userId, provider) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return null;
  let key = null;
  if (userId) {
    try { key = getSecret(getDb(), userId, cfg.vaultKey) || null; } catch { key = null; }
  }
  return key || process.env[cfg.env] || null;
}

// Resolve a user-registered `custom:<uuid>` provider for dispatch: look it up
// in the in-memory registry, then read its API key from the vault. This is the
// SINGLE source of truth used by both dispatch paths — the Code Assistant
// native tool-loop (llm_agent/runtime/route.mjs) and the legacy single-shot
// `runClaude` path (providers/runtime.mjs) — so they can't drift.
//
// Returns `{ apiKey, baseUrl, name }` on success, or `{ error, message }`
// (error ∈ 'not_found' | 'disabled' | 'no_key'); the caller surfaces `message`.
// `db` defaults to the live DB; tests pass an in-memory store. A vault read
// failure (e.g. a key that somehow isn't allow-listed) degrades to `no_key`
// rather than throwing into the model call.
export function resolveCustomProviderDispatch(provider, userId, db = getDb()) {
  const cp = getCustomProvider(provider);
  if (!cp) {
    return { error: 'not_found',
      message: `Custom provider ${provider} not found. Register it in Settings → Model Providers.` };
  }
  if (cp.isEnabled === false) {
    return { error: 'disabled',
      message: `${cp.name} is disabled. Enable it in Settings → Model Providers.` };
  }
  let apiKey = null;
  try { apiKey = userId ? getSecret(db, userId, cp.vaultKey) || null : null; }
  catch { /* non-allowlisted/corrupt → treat as no key */ }
  if (!apiKey) {
    return { error: 'no_key',
      message: `No API key configured for ${cp.name}. Add one in Settings → Model Providers.` };
  }
  return { apiKey, baseUrl: cp.baseURL, name: cp.name };
}

// ── HTTP completion ───────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);

function redact(text, key) {
  // Shared key-aware redaction (exact key + all known token shapes), then
  // bound the length for an error message. See core/redact-secrets.mjs.
  return redactWithKey(text, key).slice(0, 300);
}

async function readError(res, key) {
  let detail = '';
  try { detail = redact(await res.text(), key); } catch { /* ignore */ }
  const err = new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  err.status = res.status;
  // A 429 from a quota/billing problem won't clear on retry — don't burn the
  // backoff sequence (and more of the user's quota) hammering it. Rate-limit
  // 429s (no quota marker) stay transient.
  const quota = res.status === 429
    && /insufficient_quota|exceeded your current quota|billing|payment/i.test(detail);
  err.transient = RETRY_STATUS.has(res.status) && !quota;
  return err;
}

// OpenAI Chat Completions. Newer reasoning models reject `temperature` and
// use `max_completion_tokens`, so we send only the portable fields.
export async function callOpenAI({ apiKey, model, prompt, messages, maxTokens, signal, baseUrl, tools }) {
  // An empty/absent model would be dropped by JSON.stringify below, so the
  // request body reaches the provider with NO `model` field — which surfaces
  // as an opaque, provider-specific error (GLM: HTTP 400 code 1211 "Unknown
  // Model"; OpenAI: "you must provide a model parameter") instead of a clear,
  // actionable message. This is the single network chokepoint for every
  // OpenAI-compatible call (native tool loop + completeViaApi), so guarding
  // here turns the whole class into a loud, fixable failure.
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('No model id provided for this provider. Select a model in the Code Assistant (or Settings → Model Providers) before sending.');
  }
  const base = (baseUrl || DEFAULT_OPENAI_BASE).replace(/\/+$/, '');
  // `messages` (full array, for the native tool-calling loop) wins over `prompt`
  // (single user string, for the legacy/fence path).
  const body = {
    model,
    messages: (Array.isArray(messages) && messages.length)
      ? messages
      : [{ role: 'user', content: prompt }],
    max_completion_tokens: maxTokens,
  };
  // OpenAI-compatible function-calling (deepseek/openai/custom): expose the
  // agent's tools so the model can return a structured `tool_calls` array.
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // redirect:'error' — the apiKey rides in the Authorization header to a
    // user-supplied baseUrl; never let a 3xx forward the credential to an
    // attacker-chosen host. Matches the dispatcher/outcome-provider fetches.
    redirect: 'error',
    signal: signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, apiKey);
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  const usage = { inputTokens: data?.usage?.prompt_tokens, outputTokens: data?.usage?.completion_tokens };
  // Return tool_calls STRUCTURED (id/name/arguments) so callers can choose:
  // the native loop appends them as assistant+tool messages; the fence path
  // (completeViaApi) collapses them into a <<<TOOL_CALL>>> fence string.
  const rawCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  const toolCalls = rawCalls.map((c) => {
    const fn = c?.function || {};
    let args = {};
    if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
      try { args = JSON.parse(fn.arguments); } catch { /* malformed → empty */ }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments;
    }
    return { id: c?.id ?? null, name: fn.name, arguments: args };
  });
  const text = typeof msg?.content === 'string' ? msg.content : '';
  if (!toolCalls.length && !text) throw new Error('empty response from OpenAI-compatible endpoint');
  return { text, toolCalls, usage, headers: res.headers };
}

// Collapse structured tool_calls into the single <<<TOOL_CALL>>> fence the
// fence-based agent loop dispatches on (one call per turn, matching the fence
// contract). Used by completeViaApi for providers still driven through the
// prompt/fence path.
function toolCallsToFence(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  const tc = toolCalls[0];
  return `<<<TOOL_CALL>>>\n${JSON.stringify({ name: tc.name, arguments: tc.arguments })}\n<<<END_TOOL_CALL>>>`;
}

// Google Gemini generateContent. Model id may arrive bare or as
// `models/<id>`; the path wants the bare id.
async function callGoogle({ apiKey, model, prompt, maxTokens, signal }) {
  const id = String(model).replace(/^models\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
    // redirect:'error' — the apiKey rides in the query string here, so a 3xx
    // would forward the credential to the redirect target.
    redirect: 'error',
    signal: signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, apiKey);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text).filter(Boolean).join('') : '';
  if (!text) throw new Error('google: empty response');
  return {
    text,
    usage: { inputTokens: data?.usageMetadata?.promptTokenCount, outputTokens: data?.usageMetadata?.candidatesTokenCount },
    headers: res.headers,
  };
}

// `custom` and `deepseek` are OpenAI-compatible — same adapter, different base URL.
const API_ADAPTERS = { openai: callOpenAI, google: callGoogle, deepseek: callOpenAI, custom: callOpenAI };

/**
 * Custom provider routing: custom:uuid format holds the user-registered provider ID.
 * Resolve to the base adapter (currently all custom providers use OpenAI-compatible format).
 */
function resolveAdapter(provider) {
  if (provider?.startsWith('custom:')) {
    // User-registered custom provider — use OpenAI-compatible adapter
    return callOpenAI;
  }
  return API_ADAPTERS[provider];
}

/**
 * Run a prompt against a non-Anthropic provider over HTTP, with jittered
 * retry on transient status codes. Anthropic stays in runtime.mjs (its
 * prompt-caching / overflow handling is provider-specific). Throws on a
 * non-transient error or after exhausting retries.
 */
export async function completeViaApi(provider, { apiKey, model, prompt, maxTokens = 8192, signal, baseUrl, meter, tools } = {}) {
  const adapter = resolveAdapter(provider);
  if (!adapter) throw new Error(`completeViaApi: unsupported provider '${provider}'`);
  if (!apiKey) throw new Error(`completeViaApi: no API key for ${provider}`);
  // SSRF guard for the custom/OpenAI-compatible endpoint before any fetch.
  if ((provider === 'custom' || provider?.startsWith('custom:')) && baseUrl) {
    await assertSafeBaseUrlResolved(baseUrl);
  }
  let lastErr;
  let fellBack = false;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { text, toolCalls, usage, headers } = await adapter({ apiKey, model, prompt, maxTokens, signal, baseUrl, tools });
      log.info('provider_complete', { provider, model });
      // Best-effort usage metering — never let a ledger write break the call.
      if (meter?.userId) {
        try {
          recordUsage(getDb(), {
            userId: meter.userId, provider, model, source: 'api', endpoint: meter.endpoint,
            inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, requestId: meter.requestId,
          });
        } catch { /* ignore */ }
        try { if (headers) recordRateLimits(meter.userId, { provider, model, headers }); } catch { /* ignore */ }
      }
      // Fence-path callers get a single synthesized fence from the first native
      // tool_call so the existing <<<TOOL_CALL>>> loop dispatches unchanged.
      const fence = toolCallsToFence(toolCalls);
      return fence ? ((text && text.trim() ? text.trim() + '\n' : '') + fence) : text;
    } catch (err) {
      lastErr = err;
      // Reactive fallback on a non-transient 429 (quota/billing): flag the model
      // exhausted, then step DOWN its same-provider chain and retry once in this
      // same request — so the caller recovers now, not just on the next call.
      if (err?.status === 429 && err?.transient === false && meter?.userId) {
        try { flagQuota(getDb(), meter.userId, provider, model); } catch { /* ignore */ }
        if (!fellBack) {
          fellBack = true;
          try {
            const next = resolveUsageModel(getDb(), meter.userId, provider, new Date(), { preferModel: model });
            if (next?.model && next.model !== model) {
              log.warn('provider_reactive_fallback', { provider, from: model, to: next.model });
              if (shouldNotifyFallback(meter.userId, provider, model)) {
                try {
                  recordActivity(getDb(), {
                    userId: meter.userId, kind: 'model_fallback',
                    title: `Switched ${model} → ${next.model} (${provider} rate limit)`,
                    detail: { provider, from: model, to: next.model, reason: 'quota_429' },
                  });
                } catch { /* best effort */ }
              }
              model = next.model;
              continue;   // retry immediately with the next chain model
            }
          } catch { /* ignore — fall through to normal error handling */ }
        }
      }
      if (err.transient && attempt < RETRY_DELAYS_MS.length) {
        const delay = jittered(RETRY_DELAYS_MS[attempt]);
        log.warn('provider_retry', { provider, attempt: attempt + 1, delayMs: delay });
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── CLI subscription mode ─────────────────────────────────────────────
//
// Drive a provider's locally-logged-in CLI as a subprocess — no API key,
// uses the user's own subscription login (the same auth `claude`/`codex`/
// `gemini` use interactively). This is the no-key fallback. Invocations are
// the standard non-interactive forms; override the binary per provider with
// LLMIDE_<PROVIDER>_CLI (e.g. LLMIDE_OPENAI_CLI=codex) for installs that
// differ. (Anthropic's own CLI fallback still lives in runtime.mjs.)

const ANTHROPIC_DEFAULT_PROMPT = 'You are a helpful AI assistant.';

// The argv passed to `claude -p`. With `mcpConfigJson`, register the user's
// enabled+consented MCP servers and let the model call them; without it,
// keep today's behavior (strict-mcp-config = zero servers). Built as a pure
// function so the arg shape is unit-testable without spawning claude.
//
// The allow rule can't be a bare `mcp__*` — the CLI rejects a wildcard that
// doesn't name a scope ("Wildcard tool name ... is not supported in allow
// rules. An allow pattern must name the scope it widens ... after a literal
// mcp__<server>__ prefix", confirmed against a real `claude -p` run) — so
// build one `mcp__<serverId>__*` rule per configured server instead.
//
// `--strict-mcp-config` stays on even with `--mcp-config` set (confirmed
// against a real `claude -p` run to still load the given config): without
// it the CLI also boots every MCP server from the OPERATOR's own
// `~/.claude.json`/project config, defeating the whole point of gating
// dispatch on this user's own enabled+consented set.
export function buildAnthropicCliArgs(prompt, mcpConfig, model) {
  // Callers pass `null` for "no MCP this turn" (buildMcpConfigForUser's
  // return value for a restricted mode or zero enabled+consented plugins —
  // i.e. the common case) as well as `undefined`/omitted — a destructured
  // default parameter only covers the latter, so read via optional chaining
  // instead of `{ mcpConfigJson } = {}`, which throws on a literal `null`.
  const mcpConfigJson = mcpConfig?.mcpConfigJson;
  // `--model` rides the argv when the caller requested one — without it the
  // CLI ran its own default for every call, silently ignoring the user's
  // model picker AND the fast-model defaults of the mode classifier and
  // memory extraction (a large chunk of per-turn latency on subscription
  // installs, where every model call is a CLI spawn).
  //
  // Gated HERE, not per call site: picker values arrive raw and can hold
  // non-Anthropic ids (Cursor/Copilot/Gemini) that the CLI path always
  // silently dropped — passing them through would fail turns that work
  // today. Claude ids and the CLI's own bare aliases pass; anything else
  // (foreign id, dash-prefixed junk) omits the flag, keeping the CLI
  // default those turns always ran on. Note CLAUDE_MODEL_RE (runtime.mjs)
  // is NOT reusable here — it rejects the bare aliases.
  const CLI_MODEL_OK = /^(claude-[a-z0-9.-]+|sonnet|haiku|opus)$/;
  const modelArgs = typeof model === 'string' && CLI_MODEL_OK.test(model) ? ['--model', model] : [];
  const tail = [...modelArgs, '--strict-mcp-config', '--setting-sources', '', '--tools', '', '--system-prompt', ANTHROPIC_DEFAULT_PROMPT, '-p', prompt];
  if (typeof mcpConfigJson === 'string' && mcpConfigJson.length > 0) {
    let serverIds = [];
    try { serverIds = Object.keys(JSON.parse(mcpConfigJson)?.mcpServers || {}); } catch { /* malformed → no servers allowed */ }
    const allowedTools = serverIds.map((id) => `mcp__${id}__*`).join(',');
    return ['--mcp-config', mcpConfigJson, '--allowedTools', allowedTools, ...tail];
  }
  return tail;
}

const CLI_ARG_BUILDERS = {
  // `--strict-mcp-config` with no `--mcp-config` loads ZERO MCP servers, so a
  // cold `claude` spawn skips booting every MCP server the user has configured
  // — the dominant cost when the agent runs in CLI (no-API-key) mode and fires
  // one of these per hop. The agent supplies its own context/tools via the
  // prompt, so it never needs the user's MCP servers for a single-shot answer.
  //
  // `--tools ''` disables the CLI's built-in tools so `claude -p` behaves as a
  // single text completion rather than a full autonomous agent. Without it, a
  // heavy prompt sends the CLI off reading files / web-fetching / shelling to
  // `gh` — work that overran the per-call timeout and surfaced as a 502. The
  // server runs its own tool loop, so the CLI must answer, not act.
  //
  // `--setting-sources ''` loads ZERO setting sources (user/project/local), so
  // the spawn ignores the operator's personal Claude Code config — most
  // importantly their hooks. Without it a user-level SessionStart hook (e.g.
  // the `superpowers` plugin) injects its block into the agent's context and
  // the model narrates "I'll disregard the injected superpowers/SessionStart
  // block…" straight into the reply (and again on the nested ask-internal hop
  // → duplicated). Auth + model still resolve, so the subscription-login path
  // is unaffected — `claude -p` becomes a clean, hook-free model endpoint.
  //
  // `--system-prompt 'You are a helpful AI assistant.'` replaces Claude Code's
  // default system prompt (which declares "I'm Claude Code operating in this
  // repo…"). Without it the model breaks character — it knows it's Claude Code
  // and overrides the LLM-IDE persona injected via the user-message prompt,
  // printing commands to copy-paste instead of calling tools, and narrating its
  // Claude Code identity into replies. The replacement is intentionally minimal:
  // the real system prompt (persona, skills, tool defs) arrives in the user
  // message where the agent loop embeds it; this flag only clears the identity
  // conflict.
  // NOTE: this default-builder entry carries NO model — it is unreachable in
  // production today (runClaude's anthropic branch always passes argsOverride
  // with the resolved model). If anthropic ever routes through runViaCli,
  // thread the model here too or the model-drop latency bug returns silently.
  anthropic: (p) => buildAnthropicCliArgs(p),
  openai:    (p) => ['exec', p],   // codex exec "<prompt>"
  google:    (p) => ['-p', p],     // gemini -p "<prompt>"
};

/**
 * Parse ONE line of `claude --output-format stream-json --include-partial-messages`
 * NDJSON output. Returns `{ delta: string }` for a text delta, `{ result: string,
 * isError: boolean }` for the terminal summary line, or `{}` for anything else
 * (system/init, rate_limit_event, the full accumulated `assistant` message —
 * already covered by the deltas — content_block_start/stop, message_start/stop).
 * Never throws: a malformed or non-JSON line is silently ignored (the CLI's own
 * stderr carries real errors; a stray stdout line must not crash the parser).
 */
export function parseClaudeStreamJSON(line) {
  const trimmed = line.trim();
  if (!trimmed) return {};
  let obj;
  try { obj = JSON.parse(trimmed); } catch { return {}; }
  if (obj?.type === 'stream_event'
      && obj.event?.type === 'content_block_delta'
      && obj.event.delta?.type === 'text_delta'
      && typeof obj.event.delta.text === 'string') {
    return { delta: obj.event.delta.text };
  }
  if (obj?.type === 'result' && typeof obj.result === 'string') {
    return { result: obj.result, isError: obj.is_error === true };
  }
  return {};
}

/**
 * Argv for driving the Claude CLI with exactly one built-in web tool enabled
 * (`WebSearch` or `WebFetch`) — the "like Claude Code" web path that uses the
 * user's subscription login and needs no API key. Pass to `spawnCli('anthropic',
 * prompt, { args })`. Unlike the default loop's `--tools ''`, this allowlists a
 * single tool so the bounded search/fetch subprocess can act, while still
 * loading zero MCP servers (`--strict-mcp-config`).
 *
 * Both flags are required: `--tools` makes the tool AVAILABLE, but Claude
 * Code's permission layer still gates its USE — in headless `-p` mode it can't
 * prompt, so an un-approved tool is declined ("I don't have permission to use
 * WebFetch yet"). `--allowedTools` pre-approves it so the call actually runs.
 */
export function anthropicWebCliArgs(prompt, { tool = 'WebSearch' } = {}) {
  // `--setting-sources ''`: same hook isolation as the default builder above —
  // don't let the operator's user-level hooks/skills leak into this web hop.
  return ['--strict-mcp-config', '--setting-sources', '', '--tools', tool, '--allowedTools', tool, '-p', prompt];
}

/** The {bin, args} a provider's CLI is invoked with for a prompt. Pure —
 *  exported so the invocation is testable without spawning anything. */
export function cliInvocation(provider, prompt) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return null;
  const bin = process.env[`LLMIDE_${provider.toUpperCase()}_CLI`] || cfg.cli;
  const build = CLI_ARG_BUILDERS[provider] || ((p) => ['-p', p]);
  return { bin, args: build(prompt) };
}

// Last-resort HANG BREAKER for a CLI completion — not a work deadline.
//
// This was 120 s, which cut off real completions. It is NOT 0/unlimited either,
// because a CLI child is not just a slow request: every spawn holds one of the
// `cliSemaphore` slots below (6 total), so a single wedged `claude` process that
// never exits and never prints would retire that slot for the lifetime of the
// server, and six of them would stop all CLI completions permanently with no
// error to explain why. The HTTP path has the same protection
// (SOCKET_HANG_BREAKER_MS in runtime.mjs); this is the CLI equivalent, set to the
// same 30 minutes — far above any legitimate completion, so it only ever fires on
// something genuinely stuck.
//
// Callers that want a real, tighter ceiling pass `timeoutMs` explicitly —
// web-client.mjs does, since a web search hitting an unresponsive endpoint is a
// side lookup, not the user's work.
const CLI_TIMEOUT_MS = 1_800_000;

// Cap on concurrent CLI subprocesses across the whole process. Every CLI
// spawn (runtime.mjs's Anthropic fallback and the generic `runViaCli`) routes
// through `spawnCli`, so gating it here is the single chokepoint. Without a
// cap, N concurrent LLM requests spawn N `claude`/`codex`/`gemini` children,
// each holding file descriptors and tens-to-hundreds of MB — enough to hit
// the macOS FD ceiling and exhaust memory under load. 6 keeps a single-user
// laptop responsive while leaving headroom; override for heavier hosts.
const MAX_CONCURRENT_CLI = (() => {
  const v = Number(process.env.LLMIDE_MAX_CONCURRENT_CLI);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 6;
})();
const cliSemaphore = new Semaphore(MAX_CONCURRENT_CLI);

/**
 * Build a minimal environment for provider CLI subprocesses.
 * Mirrors the allowlist in runtime.mjs (~line 288) so that secrets like
 * LLMIDE_JWT_SECRET and LLMIDE_VAULT_KEY are never inherited by codex/gemini
 * or any other provider binary.  Pass `extraKeys` (an object of additional
 * env vars, e.g. the provider's own API key) to include those too.
 */
export function minimalCliEnv(extraKeys = {}) {
  const env = {
    PATH:            process.env.PATH            || '',
    HOME:            process.env.HOME            || '',
    TMPDIR:          process.env.TMPDIR          || '',
    TMP:             process.env.TMP             || '',
    TEMP:            process.env.TEMP            || '',
    USER:            process.env.USER            || '',
    LOGNAME:         process.env.LOGNAME         || '',
    SHELL:           process.env.SHELL           || '',
    TERM:            process.env.TERM            || '',
    LANG:            process.env.LANG            || '',
    LC_ALL:          process.env.LC_ALL          || '',
    NODE_ENV:        process.env.NODE_ENV        || '',
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '',
    XDG_DATA_HOME:   process.env.XDG_DATA_HOME   || '',
    APPDATA:         process.env.APPDATA         || '',
    USERPROFILE:     process.env.USERPROFILE     || '',
    ...extraKeys,
  };
  // Strip empty-string entries to keep the subprocess env clean.
  for (const k of Object.keys(env)) if (!env[k]) delete env[k];
  return env;
}

/**
 * Spawn a provider's CLI for a prompt and resolve its raw `{ stdout, stderr,
 * bin }`. This is the single source of truth for HOW a provider CLI is
 * invoked: the argv (from `cliInvocation`), the execFile options (maxBuffer,
 * optional `timeoutMs`/`signal`), and the stdin-close that stops the CLI
 * blocking ~3s on piped input.
 *
 * Both the generic provider path (`runViaCli`) and runtime.mjs's hardened
 * Anthropic CLI fallback build on this; each layers its own env, retry,
 * output validation, and error-message policy on top — which is why this
 * returns raw output and rejects with the raw execFile error (with `stdout`,
 * `stderr`, and `bin` attached so callers can inspect `err.code`, e.g.
 * 'ENOENT', and the captured streams).
 *
 * `env` defaults to a minimal allowlist; callers pass their own to add
 * provider-specific vars (an API key, ANTHROPIC_BASE_URL, …).
 */
export function spawnCli(provider, prompt, { env, timeoutMs = CLI_TIMEOUT_MS, signal, args: argsOverride } = {}) {
  const inv = cliInvocation(provider, prompt);
  if (!inv) return Promise.reject(new Error(`spawnCli: unknown provider '${provider}'`));
  // `argsOverride` lets a caller drive the SAME provider binary with a different
  // argv than the default single-shot completion form — e.g. enabling the
  // Claude CLI's built-in WebSearch/WebFetch (`--tools WebSearch`) for a
  // dedicated, bounded web-tool subprocess. The default loop still uses
  // `--tools ''` (no tools); only the web handlers opt in.
  const args = argsOverride || inv.args;
  // Gate the spawn behind the process-wide concurrency cap. `run` acquires a
  // slot, spawns, and releases when the child settles — so excess concurrent
  // callers queue here rather than forking unbounded subprocesses.
  return cliSemaphore.run(() => {
    // If the caller already aborted while we were queued for a slot, fail
    // fast instead of spawning a child only to immediately kill it.
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error('spawnCli: aborted'), { name: 'AbortError', bin: inv.bin }));
    }
    return new Promise((resolve, reject) => {
      const child = execFile(
        inv.bin, args,
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: env || minimalCliEnv(), signal },
        (err, stdout, stderr) => {
          if (err) {
            err.stdout = stdout;
            err.stderr = stderr;
            err.bin = inv.bin;
            reject(err);
            return;
          }
          resolve({ stdout, stderr, bin: inv.bin });
        },
      );
      // The prompt is passed via argv, not stdin. Leaving stdin open makes the
      // CLI block ~3s waiting for piped input (and warn on stderr); close it so
      // the subprocess proceeds immediately.
      child.stdin?.end();
    });
  });
}

// Per-provider NDJSON line parser: (line) => { delta?, result?, isError? }.
// A provider absent from this map has no incremental format we understand —
// spawnCliStream falls back to buffering its whole output as one onChunk call.
//
// Codex (openai) checked 2026-08-05: `codex`/`codex exec --help` fails to even
// run in this environment — `spawn ENOENT` on its vendored native binary
// (/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/.../codex),
// same failure as during the original planning pass. No `--help` output was
// obtainable, so no streaming/JSON-output flag could be verified — falls back
// to buffered delivery via the no-parser path in spawnCliStream. Re-check when
// this environment has a working codex install.
// Gemini (google) checked 2026-08-05: `gemini` is not installed at all (no
// binary on PATH, no global npm/brew package) — nothing to test. Same
// fallback applies. Re-check once `gemini` is installed here.
const STREAM_PARSERS = {
  anthropic: parseClaudeStreamJSON,
};

// Providers whose CLI needs extra args to enable streaming output, layered on
// top of their normal single-shot argv from CLI_ARG_BUILDERS.
const STREAM_ARG_EXTRAS = {
  anthropic: ['--output-format', 'stream-json', '--include-partial-messages', '--verbose'],
};

/**
 * Streaming counterpart to `spawnCli`. Spawns the provider's CLI with
 * `child_process.spawn` (not `execFile`) and reads stdout incrementally,
 * calling `onChunk(text)` for each delta as it arrives. Providers without a
 * `STREAM_PARSERS` entry (or a caller-supplied `argsOverride`/`binOverride`
 * that bypasses the provider's own streaming flags) still work correctly —
 * the whole output is delivered as a single `onChunk` call once the process
 * exits, so callers never need a special case for "does this provider
 * actually stream." Uses the same concurrency gate (`cliSemaphore`) as
 * `spawnCli` so streaming spawns count against the same cap.
 *
 * Returns `{ stdoutText, stderr, bin }` — for a caller that supplied
 * `onChunk`, `stdoutText` is the sum of every delivered delta (the
 * streaming case — the whole point of this function). For a caller with NO
 * `onChunk` (rare), `stdoutText` is the parser's own authoritative final
 * `result` text when one was reported, so a non-streaming caller still gets
 * the CLI's own canonical answer rather than a delta-reconstruction.
 *
 * `binOverride` is a test seam only (real callers never pass it) — combined
 * with `argsOverride`, it lets tests run a fast, deterministic `node -e
 * "..."` child instead of shelling out to the real provider CLI.
 *
 * `argsOverride` alone (no `binOverride`) IS used by real callers —
 * `streamModelReply` passes `buildAnthropicCliArgs(prompt, mcpConfig)` here
 * to carry the user's MCP config into a streamed anthropic-CLI call, the
 * same way `spawnCli`'s `args` override does for the buffered path. It
 * replaces `cliInvocation`'s default argv; `STREAM_ARG_EXTRAS` is still
 * layered on top so streaming output stays parseable.
 */
export function spawnCliStream(provider, prompt, {
  env, timeoutMs = CLI_TIMEOUT_MS, signal, onChunk,
  binOverride, argsOverride,
} = {}) {
  const inv = binOverride
    ? { bin: binOverride, args: argsOverride }
    : cliInvocation(provider, prompt);
  if (!inv) return Promise.reject(new Error(`spawnCliStream: unknown provider '${provider}'`));
  const parser = STREAM_PARSERS[provider];
  const args = binOverride
    ? argsOverride
    : [...(argsOverride || inv.args), ...(STREAM_ARG_EXTRAS[provider] || [])];

  return cliSemaphore.run(() => {
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error('spawnCliStream: aborted'), { name: 'AbortError', bin: inv.bin }));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(inv.bin, args, { env: env || minimalCliEnv(), signal });
      child.stdin?.end();

      let stdoutText = '';
      let parsedResult = null;
      let stderrBuf = '';
      let settled = false;

      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!parser) {
          // No parser for this provider — accumulate raw stdout, deliver as
          // one chunk when the process exits (see 'close' below).
          stdoutText += (stdoutText ? '\n' : '') + line;
          return;
        }
        const parsed = parser(line);
        if (typeof parsed.delta === 'string') {
          stdoutText += parsed.delta;
          if (typeof onChunk === 'function') onChunk(parsed.delta);
        }
        if (typeof parsed.result === 'string') {
          parsedResult = parsed;
        }
      });

      child.stderr?.on('data', (buf) => { stderrBuf += buf.toString('utf8'); });

      let timedOut = false;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (!settled) { timedOut = true; child.kill(); }
      }, timeoutMs) : null;

      const onAbort = () => { if (!settled) child.kill(); };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        err.stderr = stderrBuf;
        err.bin = inv.bin;
        reject(err);
      });

      child.on('close', (code, exitSignal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          reject(Object.assign(new Error('spawnCliStream: aborted'), { name: 'AbortError', bin: inv.bin }));
          return;
        }
        if (timedOut) {
          reject(Object.assign(new Error(`${inv.bin} timed out after ${timeoutMs}ms`), { stderr: stderrBuf, bin: inv.bin }));
          return;
        }
        if (parsedResult?.isError) {
          reject(Object.assign(new Error(`${inv.bin} reported an error result`), { stderr: stderrBuf, bin: inv.bin }));
          return;
        }
        // Any non-zero exit is a real failure UNLESS the parser already gave
        // us an authoritative clean result (isError:false) — a CLI's own
        // "this succeeded" signal takes precedence over an incidental
        // non-zero exit code from unrelated cleanup. This check is
        // deliberately NOT gated on `parser` or `stdoutText` — a no-parser
        // provider that exits non-zero must reject just as much as a parsed
        // one, and a parsed provider that streamed some deltas then crashed
        // before a terminal result line must reject too, not resolve with
        // truncated text as if it were complete.
        const hasCleanResult = parser && parsedResult && !parsedResult.isError;
        if (code !== 0 && !hasCleanResult) {
          reject(Object.assign(
            new Error(`${inv.bin} exited ${code}${exitSignal ? ` (signal ${exitSignal})` : ''}`),
            { stderr: stderrBuf, bin: inv.bin },
          ));
          return;
        }
        if (parser && !onChunk && parsedResult?.result) {
          // Caller didn't ask for incremental chunks (rare) — deliver the
          // parser's authoritative final text.
          stdoutText = parsedResult.result;
        } else if (!parser && typeof onChunk === 'function' && stdoutText) {
          // No-parser fallback: nothing was delivered incrementally above —
          // hand the whole buffered text to onChunk now, once.
          onChunk(stdoutText);
        }
        resolve({ stdoutText, stderr: stderrBuf, bin: inv.bin });
      });
    });
  });
}

/**
 * Turn a raw execFile rejection from spawnCli into a short, user-safe message.
 * Node's default err.message embeds the ENTIRE argv (including the prompt),
 * which must never reach the UI — it looks like a shell injection failure and
 * hides the real cause (usually "not logged in" on stdout).
 */
export function formatCliSpawnError(err, { bin = 'claude', apiKey, provider = 'anthropic' } = {}) {
  const stdout = String(err?.stdout || '').trim();
  const stderr = String(err?.stderr || '').trim();
  const combined = `${stdout}\n${stderr}`.trim();
  const providerLabel = provider === 'anthropic' ? 'Anthropic' : String(provider || 'model');

  if (/not logged in|please run \/login/i.test(combined)) {
    return `${bin} is not logged in. Run \`claude login\` in Terminal, or add a ${providerLabel} API key in LLM IDE → Settings → Model Providers.`;
  }
  if (err?.code === 'ENOENT') {
    return `${bin} CLI not found. Install it and run \`claude login\`, or add a ${providerLabel} API key in Settings → Model Providers.`;
  }
  if (err?.killed || /ETIMEDOUT|timed out/i.test(combined)) {
    return `${bin} timed out. Try again or add a ${providerLabel} API key in Settings → Model Providers.`;
  }
  if (combined) {
    // Collapse the dump to one labeled line: this string lands verbatim in
    // the chat's error bubble, where a bare multi-line stdout/stderr blob
    // reads as if the assistant itself produced garbage. Redact BEFORE
    // truncating (same order as redact() above) — slicing first would leave
    // the head of a credential that straddles the cap visible.
    const oneLine = combined.replace(/\s+/g, ' ').trim();
    return `${bin} failed: ${redactWithKey(oneLine, apiKey).slice(0, 300)}`;
  }
  // Never surface err.message — it contains the full command + prompt.
  const exit = typeof err?.code === 'number' ? err.code : '?';
  return `${bin} failed (exit ${exit}). Run \`claude login\` or add a ${providerLabel} API key in Settings → Model Providers.`;
}

/** Run a prompt through the provider's logged-in CLI, returning stdout. */
export function runViaCli(provider, prompt, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return Promise.reject(new Error(`runViaCli: unknown provider '${provider}'`));
  // Use a minimal env allowlist — never inherit LLMIDE_JWT_SECRET,
  // LLMIDE_VAULT_KEY, or other server secrets into provider CLI subprocesses.
  // Include the provider's own API key env var only when it is available.
  const extraKeys = cfg.env && process.env[cfg.env] ? { [cfg.env]: process.env[cfg.env] } : {};
  const env = minimalCliEnv(extraKeys);
  return spawnCli(provider, prompt, { env, timeoutMs }).then(
    ({ stdout, bin }) => {
      const text = String(stdout || '').trim();
      if (!text) throw new Error(`${bin} returned empty output`);
      log.info('provider_cli_complete', { provider, bin });
      return text;
    },
    (err) => {
      const bin = err.bin || cfg.cli;
      if (err.code === 'ENOENT') {
        throw new Error(`${bin} CLI not found — install it and log in, or add an API key in Settings → Model Providers.`);
      }
      throw new Error(formatCliSpawnError(err, { bin, provider }));
    },
  );
}

// ── Model discovery ───────────────────────────────────────────────────

// GET endpoint that lists a provider's models. Used both to verify a key
// (a 200 means the key authenticates) and to populate the model picker with
// live ids instead of a hardcoded list that drifts as models are retired.
const MODELS_ENDPOINT = {
  anthropic: (key) => ({ url: 'https://api.anthropic.com/v1/models',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }),
  openai: (key) => ({ url: 'https://api.openai.com/v1/models',
    headers: { Authorization: `Bearer ${key}` } }),
  google: (key) => ({ url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    headers: {} }),
  deepseek: (key) => ({ url: `${DEFAULT_DEEPSEEK_BASE}/v1/models`,
    headers: { Authorization: `Bearer ${key}` } }),
};

function parseModelIds(provider, data) {
  if (provider === 'google') {
    return (data?.models || [])
      .map((m) => String(m?.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  // anthropic + openai both return { data: [{ id }, …] }
  return (data?.data || []).map((m) => m?.id).filter((id) => typeof id === 'string');
}

/**
 * List a provider's available model ids over its models endpoint. Throws on
 * a non-200 (auth/transient) — callers verify or fall back to a static list.
 */
export async function listProviderModels(provider, { apiKey, baseUrl, signal } = {}) {
  if (!apiKey) throw new Error(`listProviderModels: no API key for ${provider}`);
  let url, headers;
  if (provider === 'custom') {
    if (!baseUrl) throw new Error('custom: no base URL configured');
    // SSRF guard — this path is reached by /kb/providers/verify with a raw,
    // user-supplied baseUrl (not routed through customBaseUrl's guard), and
    // it fetches WITH the API key in the Authorization header. Validate before
    // any request leaves the box.
    await assertSafeBaseUrlResolved(baseUrl);
    url = `${baseUrl.replace(/\/+$/, '')}/models`;
    headers = { Authorization: `Bearer ${apiKey}` };
  } else {
    const make = MODELS_ENDPOINT[provider];
    if (!make) throw new Error(`listProviderModels: unsupported provider '${provider}'`);
    ({ url, headers } = make(apiKey));
  }
  // redirect:'error' — custom path carries the apiKey in the Authorization
  // header to a user-supplied baseUrl; don't follow a 3xx with the credential.
  const res = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: signal || AbortSignal.timeout(15_000) });
  if (!res.ok) throw await readError(res, apiKey);
  const data = await res.json();
  return parseModelIds(provider, data);
}

// Narrow a raw provider model list to the chat/completion models worth
// showing in a picker — provider model lists also include embeddings, TTS,
// image, moderation, etc. that can't serve a prompt.
export function chatModels(provider, ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (provider === 'openai') {
    const exclude = /(embedding|tts|whisper|audio|image|realtime|moderation|dall-e|transcribe|search)/i;
    return list.filter((id) => /^(gpt-|o\d|chatgpt)/i.test(id) && !exclude.test(id));
  }
  if (provider === 'google') {
    return list.filter((id) => /^gemini-/i.test(id) && !/embedding|aqa/i.test(id));
  }
  if (provider === 'anthropic') {
    return list.filter((id) => /^claude-/i.test(id));
  }
  if (provider === 'deepseek') {
    return list.filter((id) => /deepseek/i.test(id));
  }
  return list;
}

// ── Verification ──────────────────────────────────────────────────────

/**
 * Verify a provider credential. `mode: 'key'` lists the provider's models —
 * a 200 confirms the key authenticates, at zero token cost and with no
 * dependency on a specific (retirable) probe model. `mode: 'cli'` checks the
 * provider's CLI binary is installed (interactive login state can't be
 * probed for every CLI; the first real call surfaces an auth error).
 * Always resolves — never throws — returning { ok, detail }.
 */
export async function verifyProvider({ provider, mode, apiKey, baseUrl } = {}) {
  if (!PROVIDERS[provider]) return { ok: false, detail: `unknown provider '${provider}'` };
  if (mode === 'cli') return verifyCli(provider);
  if (!apiKey) return { ok: false, detail: 'no API key provided' };
  if (provider === 'custom' && !baseUrl) return { ok: false, detail: 'no base URL configured' };
  try {
    const models = await listProviderModels(provider, { apiKey, baseUrl });
    return { ok: true, detail: `key verified — ${models.length} models available` };
  } catch (err) {
    return { ok: false, detail: redact(err.message || String(err), apiKey) };
  }
}

function verifyCli(provider) {
  const bin = PROVIDERS[provider].cli;
  if (!bin) return Promise.resolve({ ok: false, detail: `${provider} has no CLI mode — use an API key` });
  // Minimal env: the version probe only needs PATH to locate the binary.
  const env = minimalCliEnv();
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000, env }, (err) => {
      if (err) {
        resolve({
          ok: false,
          detail: err.code === 'ENOENT' ? `${bin} CLI not installed` : `version probe failed: ${(err.message || '').slice(0, 80)}`,
        });
      } else {
        resolve({ ok: true, detail: `${bin} CLI installed` });
      }
    });
  });
}

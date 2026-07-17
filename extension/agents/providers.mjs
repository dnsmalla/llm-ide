// Multi-provider model routing.
//
// `agents/runtime.mjs` keeps the hardened Anthropic HTTP + CLI path. This
// module adds the model→provider routing plus OpenAI and Google HTTP
// adapters so the same agent prompts can run against whichever provider a
// user has configured. Credentials per provider come from the vault
// (`<provider>.apiKey`) with an operator env fallback; when no key is set
// the caller can fall back to that provider's locally-logged-in CLI
// ("subscription mode" — same auth the claude/codex/gemini CLIs use).

import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { getSecret } from '../server/vault.mjs';
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
  // Generic OpenAI-compatible endpoint — covers OpenRouter, Ollama/LM Studio
  // (local), Mistral, Together, etc. The base URL is user-supplied
  // (vault `custom.baseUrl`); it is NOT id-prefix routable, so callers must
  // select it explicitly (the picker passes provider="custom").
  custom:    { vaultKey: 'custom.apiKey',    env: 'OPENAI_COMPAT_API_KEY', cli: null  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com';

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
async function callOpenAI({ apiKey, model, prompt, maxTokens, signal, baseUrl }) {
  const base = (baseUrl || DEFAULT_OPENAI_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: maxTokens,
    }),
    // redirect:'error' — the apiKey rides in the Authorization header to a
    // user-supplied baseUrl; never let a 3xx forward the credential to an
    // attacker-chosen host. Matches the dispatcher/outcome-provider fetches.
    redirect: 'error',
    signal: signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, apiKey);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) throw new Error('empty response from OpenAI-compatible endpoint');
  return {
    text,
    usage: { inputTokens: data?.usage?.prompt_tokens, outputTokens: data?.usage?.completion_tokens },
    headers: res.headers,
  };
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
 * Run a prompt against a non-Anthropic provider over HTTP, with jittered
 * retry on transient status codes. Anthropic stays in runtime.mjs (its
 * prompt-caching / overflow handling is provider-specific). Throws on a
 * non-transient error or after exhausting retries.
 */
export async function completeViaApi(provider, { apiKey, model, prompt, maxTokens = 8192, signal, baseUrl, meter } = {}) {
  const adapter = API_ADAPTERS[provider];
  if (!adapter) throw new Error(`completeViaApi: unsupported provider '${provider}'`);
  if (!apiKey) throw new Error(`completeViaApi: no API key for ${provider}`);
  // SSRF guard for the custom OpenAI-compatible endpoint before any fetch.
  if (provider === 'custom' && baseUrl) await assertSafeBaseUrlResolved(baseUrl);
  let lastErr;
  let fellBack = false;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { text, usage, headers } = await adapter({ apiKey, model, prompt, maxTokens, signal, baseUrl });
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
      return text;
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
  // and overrides the LLM IDE persona injected via the user-message prompt,
  // printing commands to copy-paste instead of calling tools, and narrating its
  // Claude Code identity into replies. The replacement is intentionally minimal:
  // the real system prompt (persona, skills, tool defs) arrives in the user
  // message where the agent loop embeds it; this flag only clears the identity
  // conflict.
  anthropic: (p) => ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '--system-prompt', 'You are a helpful AI assistant.', '-p', p],
  openai:    (p) => ['exec', p],   // codex exec "<prompt>"
  google:    (p) => ['-p', p],     // gemini -p "<prompt>"
};

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

const CLI_TIMEOUT_MS = 120_000;

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
      throw new Error(`${bin} error: ${String(err.stderr || err.message || '').slice(0, 200)}`);
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
  deepseek: (key) => ({ url: 'https://api.deepseek.com/v1/models',
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

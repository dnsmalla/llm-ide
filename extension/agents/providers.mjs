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
import { getSecret } from '../server/vault.mjs';
import { getDb } from '../kb/db.mjs';
import { logger } from '../core/logger.mjs';

const log = logger.child({ component: 'providers' });

// Per-provider config: vault key name, operator env fallback, and the CLI
// binary used for subscription (no-key) mode.
export const PROVIDERS = {
  anthropic: { vaultKey: 'claude.apiKey', env: 'ANTHROPIC_API_KEY', cli: 'claude' },
  openai:    { vaultKey: 'openai.apiKey', env: 'OPENAI_API_KEY',    cli: 'codex'  },
  google:    { vaultKey: 'google.apiKey', env: 'GOOGLE_API_KEY',    cli: 'gemini' },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

// Map a model id to its provider. A regex per family (not a fixed list)
// keeps new models working without a code change here. Unknown / blank →
// anthropic, the historical default.
export function resolveProvider(model) {
  const m = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (/^claude[-/]/.test(m)) return 'anthropic';
  if (/^(gpt[-_]|o\d|chatgpt|codex|text-davinci)/.test(m)) return 'openai';
  if (/^(gemini[-/]|models\/gemini)/.test(m)) return 'google';
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
const RETRY_DELAYS_MS = [1_000, 3_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function jitter(ms) { return Math.round(ms * (0.75 + Math.random() * 0.5)); }

function redact(text, key) {
  let s = typeof text === 'string' ? text : String(text ?? '');
  if (key && key.length >= 8) s = s.split(key).join('***');
  return s.slice(0, 300);
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
async function callOpenAI({ apiKey, model, prompt, maxTokens, signal }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: maxTokens,
    }),
    signal: signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, apiKey);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) throw new Error('openai: empty response');
  return text;
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
    signal: signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, apiKey);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text).filter(Boolean).join('') : '';
  if (!text) throw new Error('google: empty response');
  return text;
}

const API_ADAPTERS = { openai: callOpenAI, google: callGoogle };

/**
 * Run a prompt against a non-Anthropic provider over HTTP, with jittered
 * retry on transient status codes. Anthropic stays in runtime.mjs (its
 * prompt-caching / overflow handling is provider-specific). Throws on a
 * non-transient error or after exhausting retries.
 */
export async function completeViaApi(provider, { apiKey, model, prompt, maxTokens = 8192, signal } = {}) {
  const adapter = API_ADAPTERS[provider];
  if (!adapter) throw new Error(`completeViaApi: unsupported provider '${provider}'`);
  if (!apiKey) throw new Error(`completeViaApi: no API key for ${provider}`);
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const text = await adapter({ apiKey, model, prompt, maxTokens, signal });
      log.info('provider_complete', { provider, model });
      return text;
    } catch (err) {
      lastErr = err;
      if (err.transient && attempt < RETRY_DELAYS_MS.length) {
        const delay = jitter(RETRY_DELAYS_MS[attempt]);
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
  anthropic: (p) => ['-p', p],
  openai:    (p) => ['exec', p],   // codex exec "<prompt>"
  google:    (p) => ['-p', p],     // gemini -p "<prompt>"
};

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

/** Run a prompt through the provider's logged-in CLI, returning stdout. */
export function runViaCli(provider, prompt, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  const inv = cliInvocation(provider, prompt);
  if (!inv) return Promise.reject(new Error(`runViaCli: unknown provider '${provider}'`));
  return new Promise((resolve, reject) => {
    execFile(inv.bin, inv.args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new Error(`${inv.bin} CLI not found — install it and log in, or add an API key in Settings → Model Providers.`));
          return;
        }
        reject(new Error(`${inv.bin} error: ${String(stderr || err.message || '').slice(0, 200)}`));
        return;
      }
      const text = String(stdout || '').trim();
      if (!text) { reject(new Error(`${inv.bin} returned empty output`)); return; }
      log.info('provider_cli_complete', { provider, bin: inv.bin });
      resolve(text);
    });
  });
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
export async function listProviderModels(provider, { apiKey, signal } = {}) {
  const make = MODELS_ENDPOINT[provider];
  if (!make) throw new Error(`listProviderModels: unsupported provider '${provider}'`);
  if (!apiKey) throw new Error(`listProviderModels: no API key for ${provider}`);
  const { url, headers } = make(apiKey);
  const res = await fetch(url, { method: 'GET', headers, signal: signal || AbortSignal.timeout(15_000) });
  if (!res.ok) throw await readError(res, apiKey);
  const data = await res.json();
  return parseModelIds(provider, data);
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
export async function verifyProvider({ provider, mode, apiKey } = {}) {
  if (!PROVIDERS[provider]) return { ok: false, detail: `unknown provider '${provider}'` };
  if (mode === 'cli') return verifyCli(provider);
  if (!apiKey) return { ok: false, detail: 'no API key provided' };
  try {
    const models = await listProviderModels(provider, { apiKey });
    return { ok: true, detail: `key verified — ${models.length} models available` };
  } catch (err) {
    return { ok: false, detail: redact(err.message || String(err), apiKey) };
  }
}

function verifyCli(provider) {
  const bin = PROVIDERS[provider].cli;
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (err) => {
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

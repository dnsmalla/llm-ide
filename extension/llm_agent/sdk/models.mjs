// The Claude models this install can actually run, asked of the Agent SDK.
//
// The model picker used to fall back to a hardcoded list whenever the user
// had no Anthropic API key — i.e. for every `claude login` (subscription)
// user — because the only live source was GET /v1/models, which needs a key.
// That list went stale on every model release (it offered Opus 5 / Fable 5
// after Fable 5.1 shipped). The SDK can answer for either auth:
// `query().supportedModels()` is a control request on an idle session — no
// prompt is sent, no tokens are spent (~0.5 s, measured) — and it returns the
// account's own list, with display names and effort support.
//
// Cached per auth identity for a while: the list changes on model releases,
// not per turn, and each call spawns the CLI.

import { query } from '@anthropic-ai/claude-agent-sdk';
// NOTE: cyclic import (engine.mjs imports cachedEffortLevels); safe only because both sides use the imports at call time.
import { resolveAnthropicKey, agentSdkHomeFor } from './engine.mjs';

import { sdkSubprocessEnv } from './subprocess-env.mjs';
const CACHE_MS = 30 * 60 * 1000;
// A failure (not logged in, a hung CLI) is remembered briefly, so each picker
// load does not spawn a fresh CLI and wait out TIMEOUT_MS again before the
// route falls back to the key listing.
const FAILURE_CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 20_000;
const cache = new Map();
// One SDK call per auth identity at a time: concurrent picker loads share it.
const inFlight = new Map();

// ModelInfo (sdk.d.ts) → { id, displayName, description }.
//
// `id` is the canonical wire id (`resolvedModel`, e.g. 'sonnet' →
// 'claude-sonnet-5'): a stable id is what a picker should persist, and an
// alias would silently move under a saved choice. The 'default' row is the
// SDK's pointer at one of the others — it names which one goes first, then
// is dropped.
//
// `displayName` — the SDK has shipped two row shapes:
//   before 0.3.283: displayName is the bare family ("Sonnet") and the
//     description leads with the name ("Sonnet 5 · Efficient for…"), so the
//     name is the description's lead;
//   0.3.283+: displayName carries the generation ("Sonnet 5") and the
//     description is only the tagline ("Efficient for routine tasks").
// Taking the lead of a tagline-only description made every picker label a
// sentence. A bare family with no "·" lead falls back to a name built from
// the id, so two generations never share a label.
function nameFromId(id) {
  const m = /^claude-([a-z]+)-([\d-]+?)(?:-\d{8})?(?:\[1m\])?$/i.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].split('-').filter(Boolean).join('.')}`;
}

function nameOf(row, id) {
  const description = typeof row.description === 'string' ? row.description : '';
  if (description.includes('·')) {
    // "Opus 5 with 1M context" is a sentence, not a picker label.
    const lead = description.split('·')[0].trim().replace(/\s+with\s+1M\s+context$/i, ' (1M)');
    if (lead) return lead;
  }
  const dn = typeof row.displayName === 'string' ? row.displayName.trim() : '';
  if (dn && /\d/.test(dn)) return dn;
  return nameFromId(id);
}

// The SDK's own effort levels for one row, verbatim and in order. Unknown
// values pass through on purpose: a level a newer SDK adds must reach the
// picker without a code change here or in the Mac app.
function effortLevelsOf(row) {
  if (row?.supportsEffort === false || !Array.isArray(row?.supportedEffortLevels)) return [];
  return row.supportedEffortLevels.filter((l) => typeof l === 'string' && l.length > 0);
}

export function mapSupportedModels(rows) {
  if (!Array.isArray(rows)) return [];
  const idOf = (r) => (typeof r?.resolvedModel === 'string' && r.resolvedModel) || (typeof r?.value === 'string' ? r.value : '');
  const defaultId = idOf(rows.find((r) => r?.value === 'default'));
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r || r.value === 'default') continue;
    const id = idOf(r);
    if (!/^claude-/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    const description = typeof r.description === 'string' ? r.description : '';
    out.push({ id, displayName: nameOf(r, id), description, effortLevels: effortLevelsOf(r) });
  }
  if (defaultId) {
    const i = out.findIndex((m) => m.id === defaultId);
    if (i > 0) out.unshift(...out.splice(i, 1));
  }
  return out;
}

// One cache slot per auth identity: a user's own key, or the ambient login.
function cacheKeyFor(key, userId) {
  return key ? `key:${userId || ''}` : 'ambient';
}

// Mirrors AIModel.baseId (mac AICliTool.swift): lowercase, no trailing
// "[1m]", no trailing "-YYYYMMDD".
function baseId(id) {
  return String(id).toLowerCase().replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
}

/**
 * The account's Claude models, first = the SDK's default. Throws when the SDK
 * cannot answer (not logged in, no binary, timeout) — the caller falls back.
 */
export async function listSdkModels(userId, { queryFn = query, now = Date.now } = {}) {
  const { key } = resolveAnthropicKey(userId);
  const cacheKey = cacheKeyFor(key, userId);
  const hit = cache.get(cacheKey);
  if (hit?.models && now() - hit.at < CACHE_MS) return hit.models;
  if (hit?.error && now() - hit.at < FAILURE_CACHE_MS) throw hit.error;
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;
  const call = askSdk(userId, key, queryFn)
    .then((models) => { cache.set(cacheKey, { at: now(), models }); return models; })
    .catch((error) => { cache.set(cacheKey, { at: now(), error }); throw error; })
    .finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, call);
  return call;
}

/**
 * The effort levels the last SDK listing reported for `modelId`, read from
 * the cache only — never spawns the CLI. `null` = no listing cached for this
 * user's auth identity (the caller falls back); `modelId` null = the SDK
 * default, which the listing puts first; an unlisted model = [].
 */
export function cachedEffortLevels(userId, modelId) {
  const { key } = resolveAnthropicKey(userId);
  const models = cache.get(cacheKeyFor(key, userId))?.models;
  if (!Array.isArray(models)) return null;
  // Same fallback as the Mac's AIModel.baseId, so a saved pick that names the
  // model without its [1m] / date suffix still finds its row.
  const row = modelId
    ? models.find((m) => m.id === modelId) ?? models.find((m) => baseId(m.id) === baseId(modelId))
    : models[0];
  return row ? [...row.effortLevels] : [];
}

async function askSdk(userId, key, queryFn) {
  let release;
  // A streaming-input prompt that never yields a message: the session starts,
  // answers control requests, and sends nothing to the model.
  const idle = (async function* idlePrompt() { await new Promise((r) => { release = r; }); yield* []; })();
  const sdkHome = key ? agentSdkHomeFor(userId) : null;
  const q = queryFn({
    prompt: idle,
    options: {
      settingSources: [],
      tools: [],
      // Same isolation as a chat turn (engine.mjs): no claude.ai connectors,
      // the user's own key and home when they have one, ambient login otherwise.
      env: {
        ...sdkSubprocessEnv(),
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        ...(key ? { ANTHROPIC_API_KEY: key, ...(sdkHome ? { CLAUDE_CONFIG_DIR: sdkHome } : {}) } : {}),
      },
    },
  });
  let timer;
  try {
    const rows = await Promise.race([
      q.supportedModels(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('supportedModels timed out')), TIMEOUT_MS); }),
    ]);
    const models = mapSupportedModels(rows);
    if (!models.length) throw new Error('the SDK reported no Claude models');
    return models;
  } finally {
    clearTimeout(timer);
    release?.();
    try { q.close?.(); } catch { /* already closed */ }
  }
}

export function __clearSdkModelsCacheForTest() {
  cache.clear();
  inFlight.clear();
}

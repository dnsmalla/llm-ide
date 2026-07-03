// Model usage metering + same-provider auto-fallback — the backend half of
// "control all model usage like Claude's settings".
//
// The backend is the single source of truth for two questions:
//   1. "how much have I used this window?"  → usageSummary() (the dashboard)
//   2. "which model should run next?"        → resolveModel() (the auto-switch)
//
// Every dispatch path records into usage_ledger: chat/review via runClaude +
// providers.mjs, and the Mac Auto Tasks CLI via POST /kb/usage/record. Caps are
// user-set per (provider, model); defaults live here in DEFAULT_CHAINS so an
// untouched provider needs no DB rows and the feature stays inert (limit 0 = no
// cap) until the user configures it.
//
// All functions are best-effort on the write side: a metering failure must
// never throw into the model call that triggered it (mirrors activity.mjs).

// ---------------------------------------------------------------------------
// Built-in fallback chains. Order = default priority (lower index tried first).
// Same-provider only by design — we never auto-switch providers. `custom` has
// no built-ins; its models come from the user's own config.
// ---------------------------------------------------------------------------
export const DEFAULT_CHAINS = {
  anthropic: [
    { model: 'claude-opus-4-8',            label: 'Opus 4.8' },
    { model: 'claude-sonnet-4-6',          label: 'Sonnet 4.6' },
    { model: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5' },
  ],
  openai: [
    { model: 'gpt-4o',       label: 'GPT-4o' },
    { model: 'gpt-4o-mini',  label: 'GPT-4o mini' },
    { model: 'o3-mini',      label: 'o3-mini' },
  ],
  google: [
    { model: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { model: 'gemini-1.5-pro',   label: 'Gemini 1.5 Pro' },
    { model: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
  ],
  custom: [],
};

export const PROVIDERS = Object.keys(DEFAULT_CHAINS);
const VALID_UNITS = new Set(['runs', 'tokens']);
const VALID_WINDOWS = new Set(['daily', 'monthly']);
const VALID_SOURCES = new Set(['api', 'cli', 'auto-task']);

// A default (uncustomised) chain entry: enabled, no cap, run-based, daily,
// switch at 90%. limit_value 0 means "unlimited" so nothing blocks until the
// user sets a real number.
const DEFAULT_LIMIT = { enabled: 1, limit_value: 0, unit: 'runs', window_kind: 'daily', threshold_pct: 90 };

// ---------------------------------------------------------------------------
// Window math (pure). Boundaries are in the SERVER'S LOCAL TIMEZONE so they
// line up with usage_ledger.ts (stored via datetime('now','localtime')). The
// `ts >= windowStart` comparison is then apples-to-apples local strings.
// ---------------------------------------------------------------------------
export function windowStart(windowKind, now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);                 // local midnight today
  if (windowKind === 'monthly') d.setDate(1);
  return d;
}

export function resetAt(windowKind, now = new Date()) {
  const d = windowStart(windowKind, now);
  if (windowKind === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 1);
  return d;
}

// Format a Date as SQLite's local datetime string ('YYYY-MM-DD HH:MM:SS') so it
// compares correctly against the `ts` / `window_start` columns.
function toSqliteLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Small coercion helpers (defensive — inputs come off HTTP bodies).
// ---------------------------------------------------------------------------
function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
// Token counts come off an HTTP body (the Mac CLI self-reports them — the
// server can't verify a client-side LLM call). Clamp to a sane non-negative
// range so a buggy or hostile client can't poison this user's own ledger math
// with negatives (which would mask real usage) or an absurd/overflow value.
// Returns null (== "not reported") for missing/invalid input; the cap is far
// above any single request's real token count.
const MAX_TOKENS_PER_EVENT = 100_000_000; // 1e8 — orders above the largest context window
function tokenCountOrNull(v) {
  if (v == null) return null;
  const n = intOrNull(v);
  if (n == null || n < 0) return null;
  return Math.min(n, MAX_TOKENS_PER_EVENT);
}
function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
function clampStr(s, cap) {
  if (typeof s !== 'string' || !s) return null;
  return s.length > cap ? s.slice(0, cap) : s;
}

// ---------------------------------------------------------------------------
// Reads / aggregation
// ---------------------------------------------------------------------------

// Usage for one model in its current window, in its own unit. Returns a number
// (runs or summed tokens). A limit_value of 0 still computes usage so the
// dashboard can show consumption even when uncapped.
export function usedForModel(db, userId, provider, model, unit, windowKind, now = new Date()) {
  const startStr = toSqliteLocal(windowStart(windowKind, now));
  const col = unit === 'tokens'
    ? 'COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0)'
    : 'COALESCE(SUM(runs),0)';
  const row = db.prepare(
    `SELECT ${col} AS n FROM usage_ledger
      WHERE user_id=? AND provider=? AND model=? AND ts>=?`
  ).get(userId, provider, model, startStr);
  return row ? Number(row.n) : 0;
}

function isQuotaFlagged(db, userId, provider, model, windowKind, now) {
  const startStr = toSqliteLocal(windowStart(windowKind, now));
  const row = db.prepare(
    `SELECT 1 FROM quota_state
      WHERE user_id=? AND provider=? AND model=? AND window_start=? AND exhausted=1`
  ).get(userId, provider, model, startStr);
  return !!row;
}

// Merge the built-in chains with the user's stored overrides. Returns
// { chains: { provider: [ {model,label,priority,enabled,limit_value,unit,
// window_kind,threshold_pct,custom} ] } }, each chain sorted by priority.
export function getLimits(db, userId, { provider } = {}) {
  const want = provider && PROVIDERS.includes(provider) ? [provider] : PROVIDERS;
  const stored = db.prepare(
    `SELECT provider, model, priority, enabled, limit_value, unit, window_kind, threshold_pct
       FROM model_limits WHERE user_id=?`
  ).all(userId);
  const storedByKey = new Map(stored.map((r) => [`${r.provider}::${r.model}`, r]));

  const chains = {};
  for (const prov of want) {
    const defaults = DEFAULT_CHAINS[prov] || [];
    const labelByModel = new Map(defaults.map((d) => [d.model, d.label]));
    // Union of default models + any stored models for this provider (e.g. the
    // user added a custom model, or kept a model the defaults later dropped).
    const models = new Set(defaults.map((d) => d.model));
    for (const r of stored) if (r.provider === prov) models.add(r.model);

    const rows = [...models].map((model, i) => {
      const s = storedByKey.get(`${prov}::${model}`);
      const isDefault = labelByModel.has(model);
      if (s) {
        return {
          provider: prov, model,
          label: labelByModel.get(model) || model,
          priority: Number(s.priority),
          enabled: !!s.enabled,
          limit_value: Number(s.limit_value),
          unit: VALID_UNITS.has(s.unit) ? s.unit : 'runs',
          window_kind: VALID_WINDOWS.has(s.window_kind) ? s.window_kind : 'daily',
          threshold_pct: Number(s.threshold_pct),
          custom: !isDefault,
        };
      }
      return {
        provider: prov, model,
        label: labelByModel.get(model) || model,
        priority: i,
        ...DEFAULT_LIMIT,
        enabled: !!DEFAULT_LIMIT.enabled,
        custom: !isDefault,
      };
    });
    rows.sort((a, b) => a.priority - b.priority || a.model.localeCompare(b.model));
    chains[prov] = rows;
  }
  return { chains };
}

// ---------------------------------------------------------------------------
// Writes (best-effort)
// ---------------------------------------------------------------------------

// Append one usage event. provider+model+userId required; everything else
// optional. CLI/subscription callers pass no tokens (they can't report them) —
// the row still counts as one run.
export function recordUsage(db, {
  userId, provider, model, source = 'api', endpoint = null,
  inputTokens = null, outputTokens = null, runs = 1, requestId = null,
} = {}) {
  if (!userId || !provider || !model) return null;
  try {
    const info = db.prepare(
      `INSERT INTO usage_ledger
         (user_id, provider, model, source, endpoint, input_tokens, output_tokens, runs, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId, String(provider), String(model),
      VALID_SOURCES.has(source) ? source : 'api',
      clampStr(endpoint, 128),
      tokenCountOrNull(inputTokens), tokenCountOrNull(outputTokens),
      Math.max(1, Math.min(1_000_000, intOrNull(runs) || 1)),
      clampStr(requestId, 128),
    );
    maybePruneLedger(db);
    return Number(info.lastInsertRowid);
  } catch {
    return null;
  }
}

// Opportunistic retention: the ledger is append-only and would otherwise grow
// without bound. Window queries only ever look back ≤ 1 month, so anything
// older than the retention horizon is dead weight. Prune every Nth insert
// (cheap amortized cost) rather than on every write.
let _insertsSincePrune = 0;
const PRUNE_EVERY = 500;
const LEDGER_RETENTION_DAYS = 90;
function maybePruneLedger(db) {
  _insertsSincePrune += 1;
  if (_insertsSincePrune < PRUNE_EVERY) return;
  _insertsSincePrune = 0;
  try {
    const cutoff = toSqliteLocal(new Date(Date.now() - LEDGER_RETENTION_DAYS * 86_400_000));
    db.prepare('DELETE FROM usage_ledger WHERE ts < ?').run(cutoff);
  } catch { /* best effort */ }
}

// Replace the stored caps for the providers present in `chains`. Full-control
// semantics: for each provider supplied we delete its existing rows and insert
// the new set, so removing a row in the UI actually removes the override.
// Providers not present in `chains` are left untouched. Runs in one transaction.
export function setLimits(db, userId, chains) {
  if (!userId || !chains || typeof chains !== 'object') return { ok: false };
  const del = db.prepare('DELETE FROM model_limits WHERE user_id=? AND provider=?');
  const ins = db.prepare(
    `INSERT INTO model_limits
       (user_id, provider, model, priority, enabled, limit_value, unit, window_kind, threshold_pct, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`
  );
  const tx = db.transaction(() => {
    for (const [provider, models] of Object.entries(chains)) {
      if (!PROVIDERS.includes(provider) || !Array.isArray(models)) continue;
      del.run(userId, provider);
      models.forEach((m, i) => {
        const model = typeof m?.model === 'string' ? m.model.slice(0, 128) : '';
        if (!model) return;
        ins.run(
          userId, provider, model,
          clampInt(m.priority, 0, 999, i),
          m.enabled === false ? 0 : 1,
          clampInt(m.limit_value, 0, 1_000_000_000, 0),
          VALID_UNITS.has(m.unit) ? m.unit : 'runs',
          VALID_WINDOWS.has(m.window_kind) ? m.window_kind : 'daily',
          clampInt(m.threshold_pct, 1, 100, 90),
        );
      });
    }
  });
  try { tx(); return { ok: true }; }
  catch { return { ok: false }; }
}

// Flag a model as quota-exhausted for its current window (reactive path — call
// this when a live 429/quota error fires). Self-expires when the window rolls.
export function flagQuota(db, userId, provider, model, now = new Date()) {
  if (!userId || !provider || !model) return;
  try {
    const lim = (getLimits(db, userId, { provider }).chains[provider] || [])
      .find((m) => m.model === model);
    const windowKind = lim?.window_kind || 'daily';
    const startStr = toSqliteLocal(windowStart(windowKind, now));
    db.prepare(
      `INSERT INTO quota_state (user_id, provider, model, window_start, exhausted)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(user_id, provider, model, window_start)
       DO UPDATE SET exhausted=1, hit_at=datetime('now','localtime')`
    ).run(userId, provider, model, startStr);
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Resolution — the auto-switch brain.
// ---------------------------------------------------------------------------

// Pure chain-walker, separated for testing. `annotated` is the enabled chain
// with per-model {used, limit, pct, quota, exhausted, overThreshold} computed.
//   1. primary  — first model under its threshold and not exhausted
//   2. degraded — first model not exhausted (past threshold but under 100%)
//   3. paused   — all exhausted → stop until the earliest window reset
export function pickFromChain(annotated, { provider, now = new Date() } = {}) {
  if (!Array.isArray(annotated) || annotated.length === 0) {
    return { provider, model: null, status: 'unconfigured', resetAt: null,
             reason: 'No fallback chain configured.' };
  }
  const top = annotated[0];

  let pick = annotated.find((m) => !m.exhausted && !m.overThreshold);
  let status = 'ok';
  if (!pick) { pick = annotated.find((m) => !m.exhausted); status = 'degraded'; }

  if (!pick) {
    const reset = annotated
      .map((m) => resetAt(m.window_kind, now).getTime())
      .sort((a, b) => a - b)[0];
    return {
      provider, model: null, status: 'paused',
      resetAt: reset ? new Date(reset).toISOString() : null,
      reason: `All ${provider} models have hit their limit.`,
    };
  }

  const switched = pick.model !== top.model;
  const reason = switched
    ? `${top.label || top.model} at ${Math.round(top.pct)}% → using ${pick.label || pick.model}`
    : `${pick.label || pick.model}${pick.limit > 0 ? ` (${Math.round(pick.pct)}% used)` : ''}`;

  return {
    provider, model: pick.model, status,
    resetAt: resetAt(pick.window_kind, now).toISOString(),
    reason, used: pick.used, limit: pick.limit, pct: pick.pct, unit: pick.unit,
  };
}

// Annotate a provider's enabled chain with live usage, then pick. Used by the
// Auto Tasks path (GET /kb/usage/resolve) and the chat/review dispatch.
export function resolveModel(db, userId, provider, now = new Date(), { preferModel } = {}) {
  const chain = (getLimits(db, userId, { provider }).chains[provider] || [])
    .filter((m) => m.enabled);
  const annotated = chain.map((m) => {
    const used = usedForModel(db, userId, provider, m.model, m.unit, m.window_kind, now);
    const quota = isQuotaFlagged(db, userId, provider, m.model, m.window_kind, now);
    const limit = m.limit_value;
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    return {
      ...m, used, limit, pct, quota,
      exhausted: quota || (limit > 0 && used >= limit),
      overThreshold: limit > 0 && pct >= m.threshold_pct,
    };
  });
  // Respect a caller's requested model: start the walk at it so we never
  // "upgrade" to a higher-priority (costlier) model than asked for — only step
  // DOWN when the requested model is over threshold / exhausted. An absent or
  // unknown preferModel walks the whole chain from the top (Auto Tasks default).
  let candidates = annotated;
  if (preferModel) {
    const idx = annotated.findIndex((m) => m.model === preferModel);
    if (idx >= 0) candidates = annotated.slice(idx);
  }
  const result = pickFromChain(candidates, { provider, now });
  // `engaged` = the feature is actually governing this provider (a cap is set
  // or a live quota flag fired). When false the chain is inert — callers should
  // NOT override the user's own model choice, so enabling the feature with no
  // caps changes nothing (matches the "inert until configured" design rule).
  result.engaged = annotated.some((m) => m.limit > 0 || m.quota);
  return result;
}

// Full dashboard payload: every model's live usage + status, plus the resolved
// active model per provider. Powers the "Model & Limits" UI.
export function usageSummary(db, userId, { provider, now = new Date() } = {}) {
  const { chains } = getLimits(db, userId, { provider });
  const out = {};
  for (const [prov, models] of Object.entries(chains)) {
    const rows = models.map((m) => {
      const used = usedForModel(db, userId, prov, m.model, m.unit, m.window_kind, now);
      const quota = isQuotaFlagged(db, userId, prov, m.model, m.window_kind, now);
      const limit = m.limit_value;
      const pct = limit > 0 ? Math.min(999, (used / limit) * 100) : null;
      const exhausted = quota || (limit > 0 && used >= limit);
      const over = limit > 0 && pct >= m.threshold_pct;
      const state = exhausted ? 'exhausted' : (over ? 'warning' : 'ok');
      return {
        model: m.model, label: m.label, enabled: m.enabled, custom: m.custom,
        priority: m.priority, unit: m.unit, window_kind: m.window_kind,
        limit, threshold_pct: m.threshold_pct,
        used, pct, state, quota,
        resetAt: resetAt(m.window_kind, now).toISOString(),
      };
    });
    out[prov] = { active: resolveModel(db, userId, prov, now), models: rows };
  }
  return { providers: out };
}

// ---------------------------------------------------------------------------
// API rate-limit snapshot (in-memory; latest per user).
//
// Anthropic returns `anthropic-ratelimit-*` headers on every Messages
// response. These reflect API-KEY rate limits (per-minute/rolling windows) —
// NOT Claude subscription usage (which has no public API). We keep only the
// latest snapshot per user; it repopulates on the next API call and resets on
// server restart, so no persistence is needed for a live gauge. CLI/
// subscription dispatch returns no such headers, so the snapshot stays null.
// ---------------------------------------------------------------------------
const _rateLimits = new Map();   // `${userId}::${provider}` → snapshot
function rlKey(userId, provider) { return `${userId}::${provider || 'anthropic'}`; }

function numOrNullStr(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export function recordRateLimits(userId, { provider, model, headers } = {}) {
  if (!userId || !headers) return;
  const prov = provider || 'anthropic';
  const get = (k) => {
    try { return typeof headers.get === 'function' ? headers.get(k) : (headers[k] ?? null); }
    catch { return null; }
  };
  // Two header naming schemes:
  //   Anthropic           → anthropic-ratelimit-<prefix>-<limit|remaining|reset>
  //   OpenAI-compatible   → x-ratelimit-<limit|remaining|reset>-<prefix>
  // (Google's Gemini API returns no standard rate-limit headers — buckets stay null.)
  const bucket = (prefix) => {
    let limit, remaining, reset;
    if (prov === 'anthropic') {
      limit = get(`anthropic-ratelimit-${prefix}-limit`);
      remaining = get(`anthropic-ratelimit-${prefix}-remaining`);
      reset = get(`anthropic-ratelimit-${prefix}-reset`);
    } else {
      limit = get(`x-ratelimit-limit-${prefix}`);
      remaining = get(`x-ratelimit-remaining-${prefix}`);
      reset = get(`x-ratelimit-reset-${prefix}`);
    }
    const L = numOrNullStr(limit);
    const R = numOrNullStr(remaining);
    if (L == null && R == null && !reset) return null;
    return { limit: L, remaining: R, reset: reset || null };
  };
  const requests = bucket('requests');
  const tokens = bucket('tokens');
  // Anthropic also splits input/output token windows; OpenAI doesn't.
  const inputTokens = prov === 'anthropic' ? bucket('input-tokens') : null;
  const outputTokens = prov === 'anthropic' ? bucket('output-tokens') : null;
  // Nothing useful (e.g. CLI/subscription path) — don't overwrite a prior good snapshot.
  if (!requests && !tokens && !inputTokens && !outputTokens) return;
  try {
    _rateLimits.set(rlKey(userId, prov), {
      capturedAt: new Date().toISOString(),
      provider: prov,
      model: model || null,
      requests, tokens, inputTokens, outputTokens,
    });
  } catch { /* best effort */ }
}

export function getRateLimits(userId, provider) {
  if (!userId) return null;
  return _rateLimits.get(rlKey(userId, provider)) || null;
}

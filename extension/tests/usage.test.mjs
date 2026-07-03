// Usage metering + auto-fallback resolution tests. A temp DB per run applies
// the 0019 migration fresh so window/limit math is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_usage-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

let _db;
async function freshDb() {
  if (!_db) _db = await import('../kb/db.mjs');
  _db.closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* ok */ }
  }
}
async function setup() {
  await freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const db = getDb();
  const { id: userId } = registerUser(db, { email: `u-${Math.floor(performance.now()*1000)}@ex.com`, password: 'pw-12345678' });
  return { db, userId };
}

// --- pure window math ------------------------------------------------------

test('windowStart/resetAt — daily is local midnight to next midnight', async () => {
  const { windowStart, resetAt } = await import('../kb/usage.mjs');
  const now = new Date(2026, 5, 26, 14, 30, 0); // Jun 26 2026 14:30 local
  const start = windowStart('daily', now);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getDate(), 26);
  const reset = resetAt('daily', now);
  assert.equal(reset.getDate(), 27);
  assert.equal(reset.getHours(), 0);
});

test('windowStart/resetAt — monthly is the 1st to the next 1st', async () => {
  const { windowStart, resetAt } = await import('../kb/usage.mjs');
  const now = new Date(2026, 5, 26, 14, 30, 0);
  assert.equal(windowStart('monthly', now).getDate(), 1);
  const reset = resetAt('monthly', now);
  assert.equal(reset.getDate(), 1);
  assert.equal(reset.getMonth(), 6); // July
});

// --- pure pickFromChain ----------------------------------------------------

function chainEntry(model, over = {}) {
  return {
    model, label: model, window_kind: 'daily',
    used: 0, limit: 100, pct: 0, quota: false,
    exhausted: false, overThreshold: false, unit: 'runs',
    ...over,
  };
}

test('pickFromChain — picks the top model when all are healthy', async () => {
  const { pickFromChain } = await import('../kb/usage.mjs');
  const r = pickFromChain([chainEntry('a'), chainEntry('b')], { provider: 'anthropic' });
  assert.equal(r.model, 'a');
  assert.equal(r.status, 'ok');
});

test('pickFromChain — skips a model past its threshold (proactive switch)', async () => {
  const { pickFromChain } = await import('../kb/usage.mjs');
  const r = pickFromChain([
    chainEntry('a', { pct: 92, overThreshold: true }),
    chainEntry('b'),
  ], { provider: 'anthropic' });
  assert.equal(r.model, 'b');
  assert.equal(r.status, 'ok');
  assert.match(r.reason, /using b/);
});

test('pickFromChain — degraded when all past threshold but under 100%', async () => {
  const { pickFromChain } = await import('../kb/usage.mjs');
  const r = pickFromChain([
    chainEntry('a', { pct: 95, overThreshold: true }),
    chainEntry('b', { pct: 98, overThreshold: true }),
  ], { provider: 'anthropic' });
  assert.equal(r.status, 'degraded');
  assert.equal(r.model, 'a'); // first not-exhausted
});

test('pickFromChain — paused when every model is exhausted', async () => {
  const { pickFromChain } = await import('../kb/usage.mjs');
  const r = pickFromChain([
    chainEntry('a', { exhausted: true }),
    chainEntry('b', { exhausted: true, quota: true }),
  ], { provider: 'anthropic' });
  assert.equal(r.status, 'paused');
  assert.equal(r.model, null);
  assert.ok(r.resetAt);
});

// --- getLimits defaults + overrides ---------------------------------------

test('getLimits returns built-in chains by default (inert, no cap)', async () => {
  const { db, userId } = await setup();
  const { getLimits } = await import('../kb/usage.mjs');
  const { chains } = getLimits(db, userId);
  assert.deepEqual(chains.anthropic.map((m) => m.model),
    ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
  assert.equal(chains.anthropic[0].limit_value, 0); // inert until set
  assert.equal(chains.anthropic[0].enabled, true);
});

test('setLimits + getLimits round-trips user caps and reordering', async () => {
  const { db, userId } = await setup();
  const { setLimits, getLimits } = await import('../kb/usage.mjs');
  setLimits(db, userId, {
    anthropic: [
      { model: 'claude-sonnet-4-6', priority: 0, limit_value: 50, unit: 'runs', window_kind: 'daily', threshold_pct: 80 },
      { model: 'claude-opus-4-8',   priority: 1, limit_value: 10, unit: 'tokens', window_kind: 'monthly', threshold_pct: 90 },
    ],
  });
  const { chains } = getLimits(db, userId, { provider: 'anthropic' });
  assert.equal(chains.anthropic[0].model, 'claude-sonnet-4-6');
  assert.equal(chains.anthropic[0].limit_value, 50);
  assert.equal(chains.anthropic[0].threshold_pct, 80);
  assert.equal(chains.anthropic[1].unit, 'tokens');
  assert.equal(chains.anthropic[1].window_kind, 'monthly');
});

// --- recordUsage + aggregation --------------------------------------------

test('recordUsage feeds run- and token-based aggregation', async () => {
  const { db, userId } = await setup();
  const { recordUsage, usedForModel } = await import('../kb/usage.mjs');
  recordUsage(db, { userId, provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 50 });
  recordUsage(db, { userId, provider: 'anthropic', model: 'claude-opus-4-8', source: 'auto-task' }); // no tokens
  assert.equal(usedForModel(db, userId, 'anthropic', 'claude-opus-4-8', 'runs', 'daily'), 2);
  assert.equal(usedForModel(db, userId, 'anthropic', 'claude-opus-4-8', 'tokens', 'daily'), 150);
});

test('recordUsage sanity-clamps self-reported token counts (no ledger poisoning)', async () => {
  const { db, userId } = await setup();
  const { recordUsage, usedForModel } = await import('../kb/usage.mjs');
  // A negative count would mask real usage if summed in — dropped to null (unreported).
  recordUsage(db, { userId, provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: -500, outputTokens: 40 });
  // An absurd/overflow value is capped rather than allowed to dominate the window sum.
  recordUsage(db, { userId, provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 1e18, outputTokens: 0 });
  const tokens = usedForModel(db, userId, 'anthropic', 'claude-opus-4-8', 'tokens', 'daily');
  // 40 (negative→null) + 100_000_000 (capped) + 0 = 100_000_040; never negative, never 1e18.
  assert.equal(tokens, 100_000_040);
  // Both events still count as runs regardless of token validity.
  assert.equal(usedForModel(db, userId, 'anthropic', 'claude-opus-4-8', 'runs', 'daily'), 2);
});

test('recordUsage isolates users', async () => {
  const { db, userId } = await setup();
  const { registerUser } = await import('../server/users.mjs');
  const { recordUsage, usedForModel } = await import('../kb/usage.mjs');
  const other = registerUser(db, { email: 'u-other-usage@ex.com', password: 'pw-12345678' }).id;
  recordUsage(db, { userId, provider: 'anthropic', model: 'claude-opus-4-8' });
  recordUsage(db, { userId: other, provider: 'anthropic', model: 'claude-opus-4-8' });
  assert.equal(usedForModel(db, userId, 'anthropic', 'claude-opus-4-8', 'runs', 'daily'), 1);
});

// --- resolveModel end-to-end (DB) -----------------------------------------

test('resolveModel switches to the next model once usage crosses threshold', async () => {
  const { db, userId } = await setup();
  const { setLimits, recordUsage, resolveModel } = await import('../kb/usage.mjs');
  setLimits(db, userId, {
    anthropic: [
      { model: 'claude-opus-4-8',   priority: 0, limit_value: 10, unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
      { model: 'claude-sonnet-4-6', priority: 1, limit_value: 10, unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
    ],
  });
  // 9/10 on opus → 90% → at threshold → should switch to sonnet
  for (let i = 0; i < 9; i++) recordUsage(db, { userId, provider: 'anthropic', model: 'claude-opus-4-8' });
  const r = resolveModel(db, userId, 'anthropic');
  assert.equal(r.model, 'claude-sonnet-4-6');
  assert.equal(r.status, 'ok');
});

test('resolveModel pauses when the whole chain is exhausted', async () => {
  const { db, userId } = await setup();
  const { setLimits, recordUsage, resolveModel } = await import('../kb/usage.mjs');
  // Every model in the chain must be capped for the chain to pause — an
  // uncapped (limit 0) model is unlimited and would keep absorbing work. The
  // default chain includes Haiku, so cap all three.
  setLimits(db, userId, {
    anthropic: [
      { model: 'claude-opus-4-8',           priority: 0, limit_value: 2, unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
      { model: 'claude-sonnet-4-6',         priority: 1, limit_value: 2, unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
      { model: 'claude-haiku-4-5-20251001', priority: 2, limit_value: 2, unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
    ],
  });
  for (const m of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
    for (let i = 0; i < 2; i++) recordUsage(db, { userId, provider: 'anthropic', model: m });
  }
  const r = resolveModel(db, userId, 'anthropic');
  assert.equal(r.status, 'paused');
  assert.equal(r.model, null);
  assert.ok(r.resetAt);
});

test('flagQuota makes resolveModel skip the flagged model reactively', async () => {
  const { db, userId } = await setup();
  const { flagQuota, resolveModel } = await import('../kb/usage.mjs');
  // No caps set (all limit 0) — but a live quota error on opus should still
  // bump resolution to sonnet.
  flagQuota(db, userId, 'anthropic', 'claude-opus-4-8');
  const r = resolveModel(db, userId, 'anthropic');
  assert.equal(r.model, 'claude-sonnet-4-6');
  assert.equal(r.engaged, true); // a quota flag engages the chain
});

test('resolveModel is inert (engaged=false) with no caps and no quota flags', async () => {
  const { db, userId } = await setup();
  const { resolveModel } = await import('../kb/usage.mjs');
  const r = resolveModel(db, userId, 'anthropic');
  assert.equal(r.model, 'claude-opus-4-8'); // chain top
  assert.equal(r.engaged, false);           // callers should NOT override
});

test('resolveModel engages once a cap is set', async () => {
  const { db, userId } = await setup();
  const { setLimits, resolveModel } = await import('../kb/usage.mjs');
  setLimits(db, userId, {
    anthropic: [{ model: 'claude-opus-4-8', priority: 0, limit_value: 10, unit: 'runs', window_kind: 'daily', threshold_pct: 90 }],
  });
  assert.equal(resolveModel(db, userId, 'anthropic').engaged, true);
});

test('resolveModel preferModel keeps the requested model when healthy', async () => {
  const { db, userId } = await setup();
  const { resolveModel } = await import('../kb/usage.mjs');
  // No caps; ask for Sonnet (not the chain top) — should keep Sonnet, not upgrade to Opus.
  const r = resolveModel(db, userId, 'anthropic', new Date(), { preferModel: 'claude-sonnet-4-6' });
  assert.equal(r.model, 'claude-sonnet-4-6');
});

test('resolveModel preferModel steps DOWN (not up) when the requested model is exhausted', async () => {
  const { db, userId } = await setup();
  const { setLimits, recordUsage, resolveModel } = await import('../kb/usage.mjs');
  setLimits(db, userId, {
    anthropic: [
      { model: 'claude-opus-4-8',            priority: 0, limit_value: 100, unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
      { model: 'claude-sonnet-4-6',          priority: 1, limit_value: 5,   unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
      { model: 'claude-haiku-4-5-20251001',  priority: 2, limit_value: 100, unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
    ],
  });
  for (let i = 0; i < 5; i++) recordUsage(db, { userId, provider: 'anthropic', model: 'claude-sonnet-4-6' });
  // Requested Sonnet is exhausted → step DOWN to Haiku, never back up to Opus.
  const r = resolveModel(db, userId, 'anthropic', new Date(), { preferModel: 'claude-sonnet-4-6' });
  assert.equal(r.model, 'claude-haiku-4-5-20251001');
});

test('recordRateLimits parses OpenAI x-ratelimit headers under the provider key', async () => {
  const { recordRateLimits, getRateLimits } = await import('../kb/usage.mjs');
  recordRateLimits('user-oai', { provider: 'openai', model: 'gpt-4o', headers: new Map([
    ['x-ratelimit-limit-tokens', '30000'],
    ['x-ratelimit-remaining-tokens', '29000'],
  ]) });
  assert.equal(getRateLimits('user-oai', 'openai').tokens.remaining, 29000);
  assert.equal(getRateLimits('user-oai', 'anthropic'), null); // keyed per provider
});

test('usageSummary reports per-model state + active model', async () => {
  const { db, userId } = await setup();
  const { setLimits, recordUsage, usageSummary } = await import('../kb/usage.mjs');
  setLimits(db, userId, {
    anthropic: [{ model: 'claude-opus-4-8', priority: 0, limit_value: 10, unit: 'runs', window_kind: 'daily', threshold_pct: 90 }],
  });
  for (let i = 0; i < 5; i++) recordUsage(db, { userId, provider: 'anthropic', model: 'claude-opus-4-8' });
  const sum = usageSummary(db, userId, { provider: 'anthropic' });
  const opus = sum.providers.anthropic.models.find((m) => m.model === 'claude-opus-4-8');
  assert.equal(opus.used, 5);
  assert.equal(opus.pct, 50);
  assert.equal(opus.state, 'ok');
  assert.equal(sum.providers.anthropic.active.model, 'claude-opus-4-8');
});

test('recordRateLimits captures anthropic-ratelimit headers; getRateLimits returns the snapshot', async () => {
  const { recordRateLimits, getRateLimits } = await import('../kb/usage.mjs');
  const headers = new Map([
    ['anthropic-ratelimit-requests-limit', '1000'],
    ['anthropic-ratelimit-requests-remaining', '999'],
    ['anthropic-ratelimit-requests-reset', '2026-06-27T01:00:00Z'],
    ['anthropic-ratelimit-tokens-limit', '80000'],
    ['anthropic-ratelimit-tokens-remaining', '79500'],
  ]);
  recordRateLimits('user-rl-1', { provider: 'anthropic', model: 'claude-opus-4-8', headers });
  const snap = getRateLimits('user-rl-1');
  assert.equal(snap.requests.limit, 1000);
  assert.equal(snap.requests.remaining, 999);
  assert.equal(snap.tokens.remaining, 79500);
  assert.equal(snap.model, 'claude-opus-4-8');
  assert.ok(snap.capturedAt);
});

test('recordRateLimits ignores a header set with no ratelimit fields (CLI path)', async () => {
  const { recordRateLimits, getRateLimits } = await import('../kb/usage.mjs');
  recordRateLimits('user-rl-2', { provider: 'anthropic', headers: new Map([['content-type', 'text/plain']]) });
  assert.equal(getRateLimits('user-rl-2'), null);
});

test('0019 migration creates usage_ledger, model_limits, quota_state', async () => {
  await freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const db = getDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('usage_ledger','model_limits','quota_state')"
  ).all().map((r) => r.name).sort();
  assert.deepEqual(tables, ['model_limits', 'quota_state', 'usage_ledger']);
});

// The member's monthly USD cap (ADR 0021, plan Task 3): `usdCapForModel` folds `members.usd_cap_month`
// into the model-limits USD row (the smaller of the two non-zero caps), and `setLimits` may not write a
// usd row above the member's own cap. No cap anywhere = today's behaviour (null → uncapped).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_usage-member-cap-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb } = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const { usdCapForModel, setLimits, recordUsage, usedUsdMonth } = await import('../kb/usage.mjs');

const MODEL = 'claude-sonnet-5';

const { grant } = await import('./helpers/grant.mjs');

let seq = 0;
function member(usdCapMonth) {
  const user = registerUser(getDb(), {
    email: `cap-${++seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
  grant(getDb(), user.id, { teamRole: 'member', maxMode: 'execute', usdCapMonth });
  return user.id;
}

function modelUsd(userId, value) {
  getDb().prepare(
    `INSERT INTO model_limits (user_id, provider, model, priority, enabled, limit_value, unit, window_kind, threshold_pct)
     VALUES (?, 'anthropic', ?, 0, 1, ?, 'usd', 'monthly', 90)`,
  ).run(userId, MODEL, value);
}

test('member cap 5 with no model cap → 5', () => {
  const u = member(5);
  assert.equal(usdCapForModel(getDb(), u, 'anthropic', MODEL), 5);
});

test('member cap 5 with model cap 0 → 5', () => {
  const u = member(5);
  modelUsd(u, 0); // a disabled/zero row is "no cap" for the model
  assert.equal(usdCapForModel(getDb(), u, 'anthropic', MODEL), 5);
});

test('both caps set → the smaller of the two', () => {
  const a = member(5);
  modelUsd(a, 3);
  assert.equal(usdCapForModel(getDb(), a, 'anthropic', MODEL), 3);
  const b = member(5);
  modelUsd(b, 10);
  assert.equal(usdCapForModel(getDb(), b, 'anthropic', MODEL), 5);
});

test('member cap 0 means no cap: the model cap still applies (solo install unchanged)', () => {
  const u = member(0);
  modelUsd(u, 7);
  assert.equal(usdCapForModel(getDb(), u, 'anthropic', MODEL), 7);
});

test('no members row behaves exactly like before', () => {
  // Plan H1.2: registerUser now writes a members row, so this account is inserted raw to keep
  // exercising the no-authority-row path.
  const userId = `cap-norow-${++seq}`;
  getDb().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role) VALUES (?, ?, 't', 'x', 'user')",
  ).run(userId, `${userId}@example.com`);
  assert.equal(usdCapForModel(getDb(), userId, 'anthropic', MODEL), null);
  modelUsd(userId, 7);
  assert.equal(usdCapForModel(getDb(), userId, 'anthropic', MODEL), 7);
});

test('the member cap is MONTHLY: usdCapForModel answers what is LEFT of it (R-007#1)', () => {
  const u = member(20);
  // No spend yet → the whole cap.
  assert.equal(usdCapForModel(getDb(), u, 'anthropic', MODEL), 20);
  // 19.5 of 20 spent this month → one more turn may use at most 0.5.
  recordUsage(getDb(), { userId: u, provider: 'anthropic', model: MODEL, costUsd: 19.5 });
  assert.equal(usedUsdMonth(getDb(), u), 19.5);
  assert.equal(usdCapForModel(getDb(), u, 'anthropic', MODEL), 0.5);
  // A model cap below the remaining budget still wins.
  modelUsd(u, 0.25);
  assert.equal(usdCapForModel(getDb(), u, 'anthropic', MODEL), 0.25);
});

test('usedUsdMonth sums only this month and only this user', () => {
  const a = member(50);
  const b = member(50);
  recordUsage(getDb(), { userId: a, provider: 'anthropic', model: MODEL, costUsd: 2.5 });
  recordUsage(getDb(), { userId: b, provider: 'anthropic', model: MODEL, costUsd: 7 });
  // Backdated last month: excluded.
  getDb().prepare(
    "INSERT INTO usage_ledger (user_id, provider, model, source, runs, cost_usd, ts) VALUES (?, 'anthropic', ?, 'api', 1, 3.25, datetime('now', '-2 months', 'localtime'))",
  ).run(a, MODEL);
  assert.equal(usedUsdMonth(getDb(), a), 2.5);
  assert.equal(usedUsdMonth(getDb(), b), 7);
  assert.equal(usedUsdMonth(getDb(), null), 0);
  // The spend lands on the ledger row itself (migration 0069).
  assert.equal(getDb().prepare('SELECT cost_usd FROM usage_ledger WHERE user_id = ?').get(b).cost_usd, 7);
});

test('R-034 #6: recordUsage estimates a cost from tokens when the engine reported none', () => {
  const u = member(0);
  // Sonnet rates: 3 USD/M input + 15 USD/M output → 1M + 1M = 18 USD.
  const id = recordUsage(getDb(), { userId: u, provider: 'anthropic', model: MODEL, inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(getDb().prepare('SELECT cost_usd FROM usage_ledger WHERE id = ?').get(id).cost_usd, 18);
  // A reported cost still wins over the estimate.
  const reported = recordUsage(getDb(), { userId: u, provider: 'anthropic', model: MODEL, inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 0.5 });
  assert.equal(getDb().prepare('SELECT cost_usd FROM usage_ledger WHERE id = ?').get(reported).cost_usd, 0.5);
  // No tokens and no cost is still unknown.
  const none = recordUsage(getDb(), { userId: u, provider: 'anthropic', model: MODEL });
  assert.equal(getDb().prepare('SELECT cost_usd FROM usage_ledger WHERE id = ?').get(none).cost_usd, null);
});

test('recordUsage stores an unknown cost as NULL, never zero or a guess', () => {
  const u = member(0);
  const id = recordUsage(getDb(), { userId: u, provider: 'anthropic', model: MODEL });
  assert.ok(id);
  assert.equal(getDb().prepare('SELECT cost_usd FROM usage_ledger WHERE id = ?').get(id).cost_usd, null);
  const bad = recordUsage(getDb(), { userId: u, provider: 'anthropic', model: MODEL, costUsd: -1 });
  assert.equal(getDb().prepare('SELECT cost_usd FROM usage_ledger WHERE id = ?').get(bad).cost_usd, null);
});

// R-012#5: a ledger read error must fail CLOSED. Returning 0 made the monthly sum look empty, so the
// cap check let every turn through — an unlimited month on a transient DB error.
test('usedUsdMonth fails closed on a ledger read error (Infinity, never 0)', () => {
  const brokenDb = { prepare() { throw new Error('ledger unavailable'); } };
  assert.equal(usedUsdMonth(brokenDb, 'u-broken'), Number.POSITIVE_INFINITY);
  // ...so any finite member cap reads as already reached.
  assert.ok(usedUsdMonth(brokenDb, 'u-broken') >= 20);
});

test('a missing user/provider/model still answers null', () => {
  const u = member(5);
  assert.equal(usdCapForModel(getDb(), null, 'anthropic', MODEL), null);
  assert.equal(usdCapForModel(getDb(), u, null, MODEL), null);
  assert.equal(usdCapForModel(getDb(), u, 'anthropic', null), null);
});

test('setLimits clamps a usd row to the member cap and keeps its unit', () => {
  const u = member(5);
  assert.equal(setLimits(getDb(), u, {
    anthropic: [{ model: MODEL, limit_value: 50, unit: 'usd', window_kind: 'monthly' }],
  }).ok, true);
  // setLimits canonicalises the model id, so read the one row rather than matching the alias.
  const row = getDb().prepare(
    "SELECT limit_value, unit FROM model_limits WHERE user_id = ? AND provider = 'anthropic'",
  ).get(u);
  assert.deepEqual(row, { limit_value: 5, unit: 'usd' });
  assert.equal(usdCapForModel(getDb(), u, 'anthropic', MODEL), 5);
});

test('setLimits leaves a usd row alone when the member has no cap, and never touches runs/tokens rows', () => {
  const free = member(0);
  setLimits(getDb(), free, { anthropic: [{ model: MODEL, limit_value: 50, unit: 'usd' }] });
  assert.equal(
    getDb().prepare('SELECT limit_value FROM model_limits WHERE user_id = ?').get(free).limit_value,
    50,
  );

  const u = member(5);
  setLimits(getDb(), u, { anthropic: [{ model: MODEL, limit_value: 500, unit: 'tokens', window_kind: 'daily' }] });
  assert.equal(
    getDb().prepare('SELECT limit_value FROM model_limits WHERE user_id = ?').get(u).limit_value,
    500,
    'a runs/tokens cap is not dollars and is not clamped',
  );
});

after(() => {
  getDb().close();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

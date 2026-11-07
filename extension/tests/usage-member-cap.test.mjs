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
const { usdCapForModel, setLimits } = await import('../kb/usage.mjs');

const MODEL = 'claude-sonnet-5';

let seq = 0;
function member(usdCapMonth) {
  const user = registerUser(getDb(), {
    email: `cap-${++seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
  getDb().prepare(
    "INSERT INTO members (user_id, team_role, max_mode, usd_cap_month) VALUES (?, 'member', 'execute', ?)",
  ).run(user.id, usdCapMonth);
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
  const user = registerUser(getDb(), {
    email: `cap-norow-${++seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
  assert.equal(usdCapForModel(getDb(), user.id, 'anthropic', MODEL), null);
  modelUsd(user.id, 7);
  assert.equal(usdCapForModel(getDb(), user.id, 'anthropic', MODEL), 7);
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

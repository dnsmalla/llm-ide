// Retired Claude model ids (schema/models/anthropic-models.json `retired`):
// saved limits, quota flags and ledger rows written under an old id must keep
// working for its successor after a catalog update (migration 0046 +
// kb/model-ids.mjs). Ids come from the catalog so the test follows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_model-ids-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { ANTHROPIC_MODELS, canonicalModel, modelAliases, migrateRetiredModelIds } = await import('../kb/model-ids.mjs');
const usage = await import('../kb/usage.mjs');
const dbMod = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');

const RETIRED = ANTHROPIC_MODELS.retired;
const LIVE_TOP = ANTHROPIC_MODELS.chain[0].id;
// A retired id whose successor is the top of the live chain.
const OLD_TOP = Object.keys(RETIRED).find((k) => canonicalModel('anthropic', k) === LIVE_TOP);

function setup() {
  dbMod.closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* ok */ }
  }
  const db = dbMod.getDb();
  const { id: userId } = registerUser(db, {
    email: `m-${Math.floor(performance.now() * 1000)}@example.com`, password: 'pw-12345678',
  });
  return { db, userId };
}

function insertLimit(db, userId, model, priority, limit) {
  db.prepare(
    `INSERT INTO model_limits (user_id, provider, model, priority, enabled, limit_value, unit, window_kind, threshold_pct)
     VALUES (?, 'anthropic', ?, ?, 1, ?, 'runs', 'daily', 90)`,
  ).run(userId, model, priority, limit);
}

test('catalog: a retired id for the top of the chain exists', () => {
  assert.ok(OLD_TOP, 'expected a retired id that maps to the chain top');
  assert.notEqual(OLD_TOP, LIVE_TOP);
});

test('canonicalModel follows the retired map; other ids and providers pass through', () => {
  assert.equal(canonicalModel('anthropic', OLD_TOP), LIVE_TOP);
  assert.equal(canonicalModel('anthropic', LIVE_TOP), LIVE_TOP);
  assert.equal(canonicalModel('anthropic', 'my-custom-model'), 'my-custom-model');
  assert.equal(canonicalModel('openai', OLD_TOP), OLD_TOP);
  for (const live of Object.values(RETIRED)) {
    assert.ok(!Object.hasOwn(RETIRED, live), `successor ${live} must not itself be retired`);
  }
});

test('modelAliases lists the live id and every retired id that maps to it', () => {
  const ids = modelAliases('anthropic', LIVE_TOP);
  assert.equal(ids[0], LIVE_TOP);
  assert.ok(ids.includes(OLD_TOP));
  assert.deepEqual(modelAliases('openai', 'gpt-4o'), ['gpt-4o']);
});

test('a limit saved under a retired id governs its successor; resolve never returns a retired id', () => {
  const { db, userId } = setup();
  insertLimit(db, userId, OLD_TOP, 0, 5);
  const chain = usage.getLimits(db, userId, { provider: 'anthropic' }).chains.anthropic;
  const ids = chain.map((m) => m.model);
  assert.ok(!ids.some((id) => Object.hasOwn(RETIRED, id)), `no retired id in chain: ${ids}`);
  const top = chain.find((m) => m.model === LIVE_TOP);
  assert.equal(top.limit_value, 5);
  assert.equal(top.custom, false);

  const r = usage.resolveModel(db, userId, 'anthropic');
  assert.equal(r.model, LIVE_TOP);
  assert.equal(r.engaged, true);
  assert.ok(!Object.hasOwn(RETIRED, r.model));
});

test('ledger rows under a retired id count toward the successor cap', () => {
  const { db, userId } = setup();
  insertLimit(db, userId, LIVE_TOP, 0, 2);
  usage.recordUsage(db, { userId, provider: 'anthropic', model: OLD_TOP, source: 'cli', runs: 2 });
  assert.equal(usage.usedForModel(db, userId, 'anthropic', LIVE_TOP, 'runs', 'daily'), 2);
  // History keeps the id that actually ran.
  const row = db.prepare('SELECT model FROM usage_ledger WHERE user_id=?').get(userId);
  assert.equal(row.model, OLD_TOP);
  const r = usage.resolveModel(db, userId, 'anthropic');
  assert.notEqual(r.model, LIVE_TOP, 'the capped successor is exhausted by the old-id runs');
});

test('setLimits and flagQuota store live ids; a duplicate after canonicalising is dropped', () => {
  const { db, userId } = setup();
  usage.setLimits(db, userId, {
    anthropic: [
      { model: OLD_TOP, priority: 0, enabled: true, limit_value: 3 },
      { model: LIVE_TOP, priority: 1, enabled: true, limit_value: 9 },
    ],
  });
  const rows = db.prepare("SELECT model, limit_value FROM model_limits WHERE user_id=? AND provider='anthropic'").all(userId);
  assert.deepEqual(rows, [{ model: LIVE_TOP, limit_value: 3 }]);

  usage.flagQuota(db, userId, 'anthropic', OLD_TOP);
  const q = db.prepare('SELECT model FROM quota_state WHERE user_id=?').all(userId);
  assert.deepEqual(q.map((x) => x.model), [LIVE_TOP]);
});

test('migration 0046 data step re-keys limits, keeps an existing successor row, clears old quota flags, is idempotent', () => {
  const { db, userId } = setup();
  const { id: other } = registerUser(db, { email: `o-${Date.now()}@example.com`, password: 'pw-12345678' });
  insertLimit(db, userId, OLD_TOP, 0, 4);          // renamed
  insertLimit(db, other, OLD_TOP, 0, 4);           // dropped: successor row exists
  insertLimit(db, other, LIVE_TOP, 1, 7);
  db.prepare(
    "INSERT INTO quota_state (user_id, provider, model, window_start, exhausted) VALUES (?, 'anthropic', ?, '2026-01-01 00:00:00', 1)",
  ).run(userId, OLD_TOP);

  migrateRetiredModelIds(db);
  migrateRetiredModelIds(db);

  const mine = db.prepare('SELECT model, limit_value FROM model_limits WHERE user_id=?').all(userId);
  assert.deepEqual(mine, [{ model: LIVE_TOP, limit_value: 4 }]);
  const theirs = db.prepare('SELECT model, limit_value FROM model_limits WHERE user_id=?').all(other);
  assert.deepEqual(theirs, [{ model: LIVE_TOP, limit_value: 7 }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quota_state WHERE model=?').get(OLD_TOP).n, 0);
});

test('migration 0046 is registered and applied on a fresh DB', () => {
  const { db } = setup();
  const row = db.prepare('SELECT version FROM schema_migrations WHERE version=46').get();
  assert.ok(row, 'version 46 recorded');
});

test.after(() => {
  dbMod.closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* ok */ }
  }
});

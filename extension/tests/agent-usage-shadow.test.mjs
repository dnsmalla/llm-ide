// Usage shadow (Stage 2a): the mirror into agent.db's usage_calls, the one-time
// backfill of usage_ledger, the shadow compare, retention, and the rule that
// nothing about the ledger or enforcement changes. The ledger stays authoritative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DST zone for the timezone test. Set before any Date is created.
process.env.TZ = 'America/New_York';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-usage-shadow-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const main = await import('../kb/db.mjs');
const agent = await import('../kb/agent-db.mjs');
const copy = await import('../kb/agent-history-copy.mjs');
const shadow = await import('../kb/agent-usage.mjs');
const store = await import('../kb/agent-store.mjs');
const { recordUsage, windowStart, toSqliteLocal } = await import('../kb/usage.mjs');
const { config } = await import('../core/config.mjs');
const users = await import('../server/users.mjs');

const U = users.registerUser(main.getDb(), { email: 'shadow-a@example.test', password: 'CorrectHorseBattery', displayName: 'a' }).id;
const OTHER = users.registerUser(main.getDb(), { email: 'shadow-b@example.test', password: 'CorrectHorseBattery', displayName: 'b' }).id;
const agentFiles = [config.agentDbPath, `${config.agentDbPath}-wal`, `${config.agentDbPath}-shm`];

const mdb = () => main.getDb();
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

function freshAgent() {
  agent.closeAgentDb();
  for (const f of agentFiles) fs.rmSync(f, { force: true });
  const db = agent.getAgentDb();
  assert.ok(db, 'agent.db opens');
  return db;
}

function clearMain() {
  mdb().prepare('DELETE FROM usage_ledger').run();
}

const ROW = { provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'api', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 7, runs: 1, turns: 2, stopReason: 'end_turn' };

// --- mirror ----------------------------------------------------------------

test('recordUsage mirrors the ledger row into usage_calls with the same values', () => {
  clearMain();
  const db = freshAgent();
  const id = recordUsage(mdb(), { userId: U, ...ROW, endpoint: 'chat:internal', requestId: 'turn-m1' });
  assert.equal(typeof id, 'number');
  const ledger = mdb().prepare('SELECT * FROM usage_ledger WHERE id = ?').get(id);
  const mirrored = db.prepare('SELECT * FROM usage_calls WHERE request_id = ?').get('turn-m1');
  assert.ok(mirrored, 'mirrored row exists');
  assert.equal(mirrored.ts, ledger.ts, 'same ts');
  assert.equal(mirrored.day, ledger.ts.slice(0, 10), 'day is the local date of ts');
  assert.equal(mirrored.user_id, U);
  assert.equal(mirrored.provider, ledger.provider);
  assert.equal(mirrored.model, ledger.model);
  assert.equal(mirrored.endpoint, 'chat:internal');
  assert.equal(mirrored.is_internal, 1, 'internal endpoint flagged as the readers filter it');
  assert.equal(mirrored.input_tokens, 100);
  assert.equal(mirrored.cache_creation_tokens, 7);
  assert.equal(mirrored.turns, 2);
  assert.equal(mirrored.stop_reason, 'end_turn');
});

test('a plain call is mirrored with is_internal 0 and NULL endpoint kept NULL', () => {
  clearMain();
  const db = freshAgent();
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'turn-m2' });
  const row = db.prepare('SELECT endpoint, is_internal FROM usage_calls WHERE request_id = ?').get('turn-m2');
  assert.equal(row.endpoint, null);
  assert.equal(row.is_internal, 0);
});

test('a failing agent.db never fails recordUsage: the ledger row is kept and the failure is counted', () => {
  clearMain();
  freshAgent();
  const before = agent.agentStoreStatus().writeErrors;
  agent.setAgentDbForTests({
    name: 'fake',
    prepare() { throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }); },
    transaction(fn) { return fn; },
    pragma() { return 0; },
  });
  try {
    const id = recordUsage(mdb(), { userId: U, ...ROW, requestId: 'turn-fail' });
    assert.equal(typeof id, 'number', 'recordUsage still returns the ledger id');
    assert.equal(count(mdb(), 'SELECT COUNT(*) AS n FROM usage_ledger WHERE request_id = ?', 'turn-fail'), 1);
  } finally {
    agent.setAgentDbForTests(null);
  }
  assert.equal(agent.agentStoreStatus().writeErrors, before + 1, 'the failure is counted');
});

test('a store that is down (no handle) never affects recordUsage', () => {
  clearMain();
  assert.equal(shadow.mirrorUsageCall(mdb(), 1, { agentDb: null }), false);
  const id = recordUsage(mdb(), { userId: U, ...ROW, requestId: 'turn-nodb' });
  assert.equal(typeof id, 'number');
});

test('recordUsage with an incomplete call still returns null and mirrors nothing', () => {
  clearMain();
  const db = freshAgent();
  assert.equal(recordUsage(mdb(), { userId: U, provider: 'anthropic' }), null);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls'), 0);
});

// --- backfill ----------------------------------------------------------------

function seedLedger(rows) {
  const ins = mdb().prepare(
    `INSERT INTO usage_ledger (user_id, ts, provider, model, source, endpoint, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, runs, request_id, turns, stop_reason)
     VALUES (?, ?, 'anthropic', 'claude-sonnet-4-6', 'api', ?, ?, ?, NULL, NULL, 1, ?, NULL, NULL)`,
  );
  for (const r of rows) ins.run(r.user, r.ts, r.endpoint ?? null, r.input, r.output, r.req ?? null);
}

test('the backfill copies the last 90 days up to the boot floor, keeps ids, and verifies', () => {
  clearMain();
  const db = freshAgent();
  const now = new Date();
  const recent = (days) => toSqliteLocal(new Date(now.getTime() - days * 86_400_000));
  seedLedger([
    { user: U, ts: recent(1), input: 10, output: 1, req: 'old-1' },
    { user: U, ts: recent(40), input: 20, output: 2, req: 'old-2' },
    { user: OTHER, ts: recent(5), input: 30, output: 3, endpoint: 'x:internal', req: 'old-3' },
    { user: U, ts: '2020-01-01 00:00:00', input: 99, output: 9, req: 'ancient' },
  ]);
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  const floor = Number(agent.readMeta(db, 'usage_copy_floor'));
  assert.equal(floor, mdb().prepare('SELECT MAX(id) AS m FROM usage_ledger').get().m);
  // A row written after the boot floor is mirrored live, with a larger id.
  const liveId = recordUsage(mdb(), { userId: U, ...ROW, requestId: 'live-1' });
  assert.ok(liveId > floor, 'live id is above the floor');
  // Rows added to the ledger after boot are never backfilled.
  seedLedger([{ user: U, ts: recent(0), input: 1, output: 1, req: 'after-boot' }]);
  let steps = 0;
  while (!copy.copyUsageStep({ mainDb: mdb(), agentDb: db, batch: 2 }).done) steps += 1;
  assert.ok(steps >= 1, 'the copy ran in several batches');
  assert.equal(agent.readMeta(db, 'copy_verified:usage_ledger'), 'ok');
  assert.equal(copy.usageCopyDone({ agentDb: db, mainDb: mdb() }), true);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM usage_calls WHERE request_id = 'ancient'"), 0, 'older than 90 days is not copied');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM usage_calls WHERE request_id = 'old-1'"), 1);
  assert.equal(db.prepare("SELECT id FROM usage_calls WHERE request_id = 'old-1'").get().id,
    mdb().prepare("SELECT id FROM usage_ledger WHERE request_id = 'old-1'").get().id, 'copied rows keep the ledger id');
  assert.equal(db.prepare("SELECT is_internal FROM usage_calls WHERE request_id = 'old-3'").get().is_internal, 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM usage_calls WHERE request_id = 'live-1'"), 1, 'the live row is not copied twice');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM usage_calls WHERE request_id = 'after-boot'"), 0, 'post-boot ledger rows are not copied');
});

test('the backfill resumes after a restart with the same bounds', () => {
  clearMain();
  const db = freshAgent();
  const now = new Date();
  const recent = (days) => toSqliteLocal(new Date(now.getTime() - days * 86_400_000));
  seedLedger([1, 2, 3, 4, 5].map((i) => ({ user: U, ts: recent(i), input: i, output: 0, req: `r${i}` })));
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  const floor = agent.readMeta(db, 'usage_copy_floor');
  const first = copy.copyUsageStep({ mainDb: mdb(), agentDb: db, batch: 2 });
  assert.equal(first.done, false);
  assert.equal(first.copied, 2);
  // A "restart": the boot step runs again. It must keep the same floor and cursor.
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  assert.equal(agent.readMeta(db, 'usage_copy_floor'), floor, 'the floor is not moved on a resumed boot');
  while (!copy.copyUsageStep({ mainDb: mdb(), agentDb: db, batch: 2 }).done) { /* drain */ }
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls'), 5, 'every row once, none twice');
  assert.equal(agent.readMeta(db, 'copy_verified:usage_ledger'), 'ok');
});

// --- compare -----------------------------------------------------------------

function captureLogger() {
  const warnings = [];
  return { warnings, warn: (event, data) => warnings.push({ event, data }), error() {}, info() {} };
}

function finishedCopy(db) {
  while (!copy.copyUsageStep({ mainDb: mdb(), agentDb: db, batch: 50 }).done) { /* drain */ }
}

test('the compare reports clean when the shadow equals the ledger, and stores the result', () => {
  clearMain();
  const db = freshAgent();
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'c1' });
  recordUsage(mdb(), { userId: OTHER, ...ROW, model: 'claude-opus-4-1', requestId: 'c2' });
  finishedCopy(db);
  const logger = captureLogger();
  const result = shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, logger });
  assert.equal(result.ok, true);
  assert.equal(result.mismatches, 0);
  assert.deepEqual(result.sample, []);
  assert.equal(result.windows.today.ledgerRows, 2);
  assert.equal(result.windows.today.shadowRows, 2);
  assert.equal(logger.warnings.length, 0);
  assert.equal(shadow.lastShadowCompare(db).ok, true);
  assert.equal(agent.agentStoreStatus().shadow.ok, true);
});

test('the compare detects an injected mismatch, names it, and logs a warning', () => {
  clearMain();
  const db = freshAgent();
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  const id = recordUsage(mdb(), { userId: U, ...ROW, requestId: 'm1' });
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'm2' });
  finishedCopy(db);
  db.prepare('DELETE FROM usage_calls WHERE request_id = ?').run('m1');
  const logger = captureLogger();
  const result = shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, logger });
  assert.equal(result.ok, false);
  assert.ok(result.mismatches > 0);
  assert.equal(result.sample[0].provider, 'anthropic');
  assert.equal(result.sample[0].model, 'claude-sonnet-4-6');
  assert.ok(result.sample[0].fields.includes('n'));
  assert.equal(logger.warnings[0].event, 'agent_usage_shadow_mismatch');
  assert.equal(agent.readMeta(db, 'shadow_mismatches'), String(result.mismatches));
  assert.equal(agent.agentStoreStatus().shadow.ok, false);
  assert.ok(id > 0);
});

test('the compare scoped to one user only looks at that user', () => {
  clearMain();
  const db = freshAgent();
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'u1' });
  recordUsage(mdb(), { userId: OTHER, ...ROW, requestId: 'u2' });
  finishedCopy(db);
  db.prepare('DELETE FROM usage_calls WHERE request_id = ?').run('u2');
  const mine = shadow.compareLedgerShadow(U, { mainDb: mdb(), agentDb: db, logger: captureLogger() });
  assert.equal(mine.ok, true, 'the other user\'s gap is not in this scope');
  const all = shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, logger: captureLogger() });
  assert.equal(all.ok, false);
});

test('the compare reports unavailable without a store', () => {
  assert.deepEqual(shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: null }), { ok: false, reason: 'unavailable' });
});

// --- timezone and day key (DST zone) -----------------------------------------

test('ledger rows around local midnight land in the same day as the window start', () => {
  // 2026-03-08 is the US spring-forward day in America/New_York.
  const now = new Date(2026, 2, 8, 12, 0, 0);
  const cutoffToday = toSqliteLocal(windowStart('daily', now));
  assert.equal(cutoffToday, '2026-03-08 00:00:00');
  assert.equal(shadow.shadowWindowCutoff(1, now), '2026-03-08 00:00:00');
  assert.equal(shadow.shadowWindowCutoff(7, now), '2026-03-02 00:00:00', 'seven local days across DST');
  assert.equal(new Date(2026, 2, 8, 12).getTimezoneOffset(), 240, 'the test runs in the DST zone (EDT)');
  for (const [ts, day, inToday] of [
    ['2026-03-07 23:59:59', '2026-03-07', false],
    ['2026-03-08 00:00:00', '2026-03-08', true],
    ['2026-03-08 03:30:00', '2026-03-08', true],
  ]) {
    const row = shadow.shadowRowFromLedger({ user_id: U, ts, provider: 'anthropic', model: 'm' });
    assert.equal(row[1], day, `day of ${ts}`);
    assert.equal(ts >= cutoffToday, inToday, `window membership of ${ts}`);
  }
});

test('the compare buckets DST-day rows the way the budget window does', () => {
  clearMain();
  const db = freshAgent();
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  for (const ts of ['2026-03-07 23:59:59', '2026-03-08 00:00:00', '2026-03-08 03:30:00']) {
    mdb().prepare(`INSERT INTO usage_ledger (user_id, ts, provider, model, input_tokens, output_tokens, runs)
      VALUES (?, ?, 'anthropic', 'claude-sonnet-4-6', 1, 1, 1)`).run(U, ts);
    shadow.mirrorUsageCall(mdb(), mdb().prepare('SELECT MAX(id) AS m FROM usage_ledger').get().m, { agentDb: db });
  }
  finishedCopy(db);
  const now = new Date(2026, 2, 8, 12, 0, 0);
  const result = shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, now, logger: captureLogger() });
  assert.equal(result.ok, true);
  assert.equal(result.windows.today.ledgerRows, 2, 'today: local midnight onward');
  assert.equal(result.windows.today.shadowRows, 2);
  assert.equal(result.windows.days7.ledgerRows, 3, 'seven days reach back over the late-night row');
  assert.equal(result.windows.days7.shadowRows, 3);
});

// --- retention, clear, purge ------------------------------------------------

test('pruneUsageCalls keeps the ledger retention (90 days) and nothing newer', () => {
  clearMain();
  const db = freshAgent();
  const now = new Date();
  db.prepare("INSERT INTO usage_calls (user_id, day, ts, provider, model, runs) VALUES (?, '2020-01-01', '2020-01-01 00:00:00', 'a', 'm', 1)").run(U);
  db.prepare("INSERT INTO usage_calls (user_id, day, ts, provider, model, runs) VALUES (?, ?, ?, 'a', 'm', 1)")
    .run(U, toSqliteLocal(now).slice(0, 10), toSqliteLocal(now));
  assert.equal(shadow.pruneUsageCalls({ agentDb: db, now }), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls'), 1);
});

test('clear never deletes usage_calls, and a user purge does', () => {
  clearMain();
  const db = freshAgent();
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'k1' });
  recordUsage(mdb(), { userId: OTHER, ...ROW, requestId: 'k2' });
  store.clearHistory(U, { scope: 'all', dryRun: false, db });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls WHERE user_id = ?', U), 1, 'clear leaves the budget shadow alone');
  assert.ok(store.AGENT_USER_TABLES.includes('usage_calls'));
  store.purgeUser(U, { db });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls WHERE user_id = ?', U), 0, 'purge removes the user');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls WHERE user_id = ?', OTHER), 1);
});

test('the ledger itself is unchanged by the shadow: same rows, same ids, same prune', () => {
  clearMain();
  freshAgent();
  const a = recordUsage(mdb(), { userId: U, ...ROW, requestId: 'same-1' });
  const b = recordUsage(mdb(), { userId: U, ...ROW, requestId: 'same-2' });
  assert.equal(b, a + 1, 'ledger ids are consecutive, as before');
  assert.equal(count(mdb(), 'SELECT COUNT(*) AS n FROM usage_ledger WHERE user_id = ?', U), 2);
});

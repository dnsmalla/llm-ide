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
const jobs = await import('../kb/agent-jobs.mjs');

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

// Bounded drain: a copy that fails (mismatch, gave up) stops the loop instead of spinning.
function drain(db, batch = 2) {
  let last = null;
  for (let i = 0; i < 10_000; i += 1) {
    last = copy.copyUsageStep({ mainDb: mdb(), agentDb: db, batch });
    if (last.done || !last.ok) return last;
  }
  throw new Error('copy did not finish');
}

// A store past its boot step: the id floor exists, so the mirror writes.
function bootAgent() {
  const db = freshAgent();
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  return db;
}

function clearMain() {
  mdb().prepare('DELETE FROM usage_ledger').run();
}

const ROW = { provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'api', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 7, runs: 1, turns: 2, stopReason: 'end_turn' };

// --- mirror ----------------------------------------------------------------

test('recordUsage mirrors the ledger row into usage_calls with the same values', () => {
  clearMain();
  const db = bootAgent();
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
  const db = bootAgent();
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'turn-m2' });
  const row = db.prepare('SELECT endpoint, is_internal FROM usage_calls WHERE request_id = ?').get('turn-m2');
  assert.equal(row.endpoint, null);
  assert.equal(row.is_internal, 0);
});

test('a failing agent.db never fails recordUsage: the ledger row is kept and the failure is counted', () => {
  clearMain();
  bootAgent();
  const before = agent.agentStoreStatus().writeErrors;
  // Only the mirror's insert fails; the floor check (a meta read) still works.
  const real = agent.getAgentDb();
  agent.setAgentDbForTests({
    name: 'fake',
    prepare(sql) {
      if (/INSERT INTO usage_calls/.test(sql)) throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      return real.prepare(sql);
    },
    transaction(fn) { return real.transaction(fn); },
    pragma(...a) { return real.pragma(...a); },
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
  assert.equal(shadow.mirrorUsageCall({ user_id: U, ts: '2026-10-01 10:00:00', provider: 'a', model: 'm' }, { agentDb: null }), false);
  const id = recordUsage(mdb(), { userId: U, ...ROW, requestId: 'turn-nodb' });
  assert.equal(typeof id, 'number');
});

test('recordUsage with an incomplete call still returns null and mirrors nothing', () => {
  clearMain();
  const db = bootAgent();
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
  assert.equal(drain(db, 2).done, true);
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
  assert.equal(drain(db, 2).done, true);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls'), 5, 'every row once, none twice');
  assert.equal(agent.readMeta(db, 'copy_verified:usage_ledger'), 'ok');
});

// --- compare -----------------------------------------------------------------

function captureLogger() {
  const warnings = [];
  const push = (level) => (event, data) => warnings.push({ level, event, data });
  return { warnings, warn: push('warn'), error: push('error'), info() {} };
}

function finishedCopy(db) {
  assert.equal(drain(db, 50).done, true, 'the copy finished and verified');
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
    shadow.mirrorUsageCall({
      user_id: U, ts, provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'api', endpoint: null,
      input_tokens: 1, output_tokens: 1, cache_read_tokens: null, cache_creation_tokens: null, runs: 1,
      request_id: null, turns: null, stop_reason: null,
    }, { agentDb: db });
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

// --- boot order and copy verification (review fix 1) -----------------------

test('the mirror writes nothing before the id floor exists (lazy open, no boot step)', () => {
  clearMain();
  const db = freshAgent();
  const before = agent.agentStoreStatus().writeErrors;
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'pre-floor' });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls'), 0, 'nothing mirrored without a floor');
  assert.equal(agent.agentStoreStatus().writeErrors, before, 'not a failure either');
});

test('lazy open, rows before the boot step: the backfill copies every ledger row once, with its tokens', () => {
  clearMain();
  const db = freshAgent();
  const tokens = [[101, 11], [202, 22], [303, 33], [404, 44], [505, 55]];
  tokens.forEach(([input, output], i) => recordUsage(mdb(), {
    userId: U, provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: input, outputTokens: output, requestId: `pre-${i}`,
  }));
  recordUsage(mdb(), { userId: U, ...ROW, inputTokens: 606, outputTokens: 66, requestId: 'pre-6' });
  recordUsage(mdb(), { userId: U, ...ROW, inputTokens: 707, outputTokens: 77, requestId: 'pre-7' });
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  assert.equal(drain(db, 2).done, true);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls'), 7);
  assert.equal(count(db, 'SELECT COUNT(DISTINCT id) AS n FROM usage_calls'), 7, 'no duplicate ids');
  const sums = db.prepare('SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM usage_calls').get();
  const want = mdb().prepare('SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM usage_ledger').get();
  assert.deepEqual({ i: sums.i, o: sums.o }, { i: want.i, o: want.o });
  assert.equal(agent.readMeta(db, 'copy_verified:usage_ledger'), 'ok');
});

test('leftover shadow rows with no floor are cleared before the bounds are set', () => {
  clearMain();
  const db = freshAgent();
  db.prepare("INSERT INTO usage_calls (id, user_id, day, ts, provider, model, runs, input_tokens) VALUES (1, ?, '2026-10-01', '2026-10-01 10:00:00', 'anthropic', 'm', 1, 999)").run(U);
  seedRowsForLeftover();
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  assert.equal(drain(db, 10).done, true);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls WHERE input_tokens = 999'), 0, 'the leftover is gone');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls'), mdb().prepare('SELECT COUNT(*) AS n FROM usage_ledger').get().n);
});

function seedRowsForLeftover() {
  mdb().prepare(`INSERT INTO usage_ledger (user_id, ts, provider, model, input_tokens, output_tokens, runs)
    VALUES (?, ?, 'anthropic', 'm', 5, 5, 1)`).run(U, toSqliteLocal(new Date()));
}

test('a copy whose totals differ (same count, different tokens) is not marked done and is retried next boot', () => {
  clearMain();
  const db = freshAgent();
  recordUsage(mdb(), { userId: U, ...ROW, inputTokens: 1000, outputTokens: 10, requestId: 'v-1' });
  recordUsage(mdb(), { userId: U, ...ROW, inputTokens: 2000, outputTokens: 20, requestId: 'v-2' });
  recordUsage(mdb(), { userId: U, ...ROW, inputTokens: 3000, outputTokens: 30, requestId: 'v-3' });
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  // Pre-fill id 2 with different tokens: INSERT OR IGNORE then skips the ledger row, so
  // the COUNT matches while the token sums do not. The verifier must catch that.
  const ledgerIds = mdb().prepare("SELECT id FROM usage_ledger ORDER BY id").all().map((r) => r.id);
  db.prepare('DELETE FROM usage_calls').run();
  db.prepare("INSERT INTO usage_calls (id, user_id, day, ts, provider, model, runs, input_tokens) VALUES (?, ?, '2026-10-01', '2026-10-01 10:00:00', 'anthropic', 'm', 1, 9999)")
    .run(ledgerIds[1], U);
  const r = drain(db, 10);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'verify_mismatch');
  assert.equal(agent.readMeta(db, 'copy_done:usage_ledger'), null, 'copy_done is never written on a mismatch');
  assert.equal(copy.usageCopyDone({ agentDb: db, mainDb: mdb() }), false);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls'), 0, 'the attempt removed what it wrote');
  assert.equal(copy.copyUsageStep({ mainDb: mdb(), agentDb: db }).reason, 'verify_retry_next_boot', 'no retry in this process');
  // Next boot: the retry runs from scratch and succeeds.
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  assert.equal(drain(db, 10).done, true);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM usage_calls WHERE input_tokens = 9999'), 0);
  assert.equal(agent.readMeta(db, 'copy_verified:usage_ledger'), 'ok');
});

test('the copy gives up after the attempt cap, and says so', () => {
  clearMain();
  const db = freshAgent();
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'cap-1' });
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'cap-2' });
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  const ids = mdb().prepare('SELECT id FROM usage_ledger ORDER BY id').all().map((r) => r.id);
  for (let boot = 0; boot < copy.USAGE_MAX_ATTEMPTS; boot += 1) {
    db.prepare("INSERT OR REPLACE INTO usage_calls (id, user_id, day, ts, provider, model, runs, input_tokens) VALUES (?, ?, '2026-10-01', '2026-10-01 10:00:00', 'anthropic', 'm', 1, 7777)")
      .run(ids[0], U);
    const r = drain(db, 10);
    assert.equal(r.reason, 'verify_mismatch');
    copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  }
  assert.equal(agent.readMeta(db, 'usage_copy_gave_up'), '1');
  assert.equal(copy.copyUsageStep({ mainDb: mdb(), agentDb: db }).reason, 'gave_up');
  assert.equal(copy.usageCopyDone({ agentDb: db, mainDb: mdb() }), false);
});

// --- hot path and failure isolation (review fix 2, 3, 4, 6) -----------------

test('the mirror equals the ledger row exactly, after clamping, with no read-back', () => {
  clearMain();
  const db = bootAgent();
  const id = recordUsage(mdb(), {
    userId: U, provider: 'anthropic', model: 'claude-opus-4-1', source: 'bogus', endpoint: 'x'.repeat(200) + ':internal',
    inputTokens: -5, outputTokens: 2_000_000_000, cacheReadTokens: 3, cacheCreationTokens: null,
    runs: 5_000_000, requestId: 'r'.repeat(200), turns: 4, stopReason: 'end_turn',
  });
  const ledger = mdb().prepare('SELECT * FROM usage_ledger WHERE id = ?').get(id);
  const mirror = db.prepare('SELECT * FROM usage_calls WHERE request_id = ?').get(ledger.request_id);
  assert.ok(mirror);
  for (const k of ['ts', 'provider', 'model', 'source', 'endpoint', 'input_tokens', 'output_tokens',
    'cache_read_tokens', 'cache_creation_tokens', 'runs', 'request_id', 'turns', 'stop_reason']) {
    assert.deepEqual(mirror[k], ledger[k], `column ${k}`);
  }
  assert.equal(mirror.day, ledger.ts.slice(0, 10));
  // The clamp cuts the endpoint to 128 characters, so the ':internal' suffix is gone on both sides.
  assert.equal(mirror.is_internal, 0);
  assert.equal(ledger.endpoint.length, 128);
});

test('a main-DB error in the ledger insert returns null and never touches agent.db', () => {
  clearMain();
  bootAgent();
  const before = agent.agentStoreStatus();
  const brokenMain = { prepare() { throw Object.assign(new Error('main read error'), { code: 'SQLITE_ERROR' }); } };
  assert.equal(recordUsage(brokenMain, { userId: U, ...ROW, requestId: 'main-err' }), null);
  const after = agent.agentStoreStatus();
  assert.equal(after.writeErrors, before.writeErrors, 'no agent write failure is counted');
  assert.equal(after.quarantinesThisProcess, before.quarantinesThisProcess, 'the healthy agent.db is not quarantined');
  assert.equal(after.state, 'ok');
});

test('a corruption-class error during the mirror does not change the ledger return value', () => {
  clearMain();
  const real = bootAgent();
  const id = recordUsage(mdb(), { userId: U, ...ROW, requestId: 'corrupt-ok' });
  assert.equal(typeof id, 'number');
  const before = agent.agentStoreStatus().writeErrors;
  // Every mirror insert reports corruption. No file is attached, so nothing is moved.
  agent.setAgentDbForTests({
    name: 'corrupt-fake',
    prepare(sql) {
      if (/INSERT INTO usage_calls/.test(sql)) throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
      return real.prepare(sql);
    },
    transaction(fn) { return real.transaction(fn); },
    pragma(...a) { return real.pragma(...a); },
  });
  try {
    const next = recordUsage(mdb(), { userId: U, ...ROW, requestId: 'corrupt-next' });
    assert.equal(typeof next, 'number', 'the return value is the ledger id');
    assert.equal(count(mdb(), "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_id = 'corrupt-next'"), 1);
  } finally {
    agent.setAgentDbForTests(null);
  }
  assert.equal(agent.agentStoreStatus().writeErrors, before + 1);
});

test('failure logs are rate limited to one line per minute; the counter counts every failure', () => {
  clearMain();
  agent.closeAgentDb();
  for (const f of agentFiles) fs.rmSync(f, { force: true });
  const logger = captureLogger();
  assert.ok(agent.openAgentDb({ logger }), 'opens with a logger');
  agent.resetWriteFailureLogForTests();
  const before = agent.agentStoreStatus().writeErrors;
  for (let i = 0; i < 3; i += 1) agent.noteAgentWriteFailure(Object.assign(new Error('x'), { code: 'SQLITE_IOERR' }));
  const errors = logger.warnings.filter((w) => w.event === 'agent_db_write_failed');
  assert.equal(agent.agentStoreStatus().writeErrors, before + 3, 'every failure is counted');
  assert.equal(errors.length, 1, 'three failures inside a minute log one line');
});

// --- compare false negatives and the independent daily step (review fix 5) ---

test('the compare flags tokens, is_internal, day and source divergence that counts alone would miss', () => {
  clearMain();
  const db = freshAgent();
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'fn-1', endpoint: 'chat:internal', inputTokens: 100 });
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'fn-2', inputTokens: 200 });
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  finishedCopy(db);
  // Clean first, so the mutations below are the only differences.
  assert.equal(shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, logger: captureLogger() }).ok, true);

  // Same row count, same runs, token sums moved by one.
  db.prepare("UPDATE usage_calls SET input_tokens = input_tokens + 1 WHERE request_id = 'fn-2'").run();
  let r = shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, logger: captureLogger() });
  assert.equal(r.ok, false);
  assert.ok(r.sample.some((x) => x.fields.includes('input')), 'token sum flagged');
  db.prepare("UPDATE usage_calls SET input_tokens = input_tokens - 1 WHERE request_id = 'fn-2'").run();

  // The internal flag flipped on the internal row.
  db.prepare("UPDATE usage_calls SET is_internal = 0 WHERE request_id = 'fn-1'").run();
  r = shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, logger: captureLogger() });
  assert.ok(r.sample.some((x) => x.fields.includes('internal')), 'is_internal flagged');
  db.prepare("UPDATE usage_calls SET is_internal = 1 WHERE request_id = 'fn-1'").run();

  // A day that does not match ts.
  db.prepare("UPDATE usage_calls SET day = '2020-01-01' WHERE request_id = 'fn-2'").run();
  r = shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, logger: captureLogger() });
  assert.ok(r.sample.some((x) => x.fields.includes('badDay')), 'day mismatch flagged');
  db.prepare("UPDATE usage_calls SET day = substr(ts, 1, 10) WHERE request_id = 'fn-2'").run();

  // A source that differs.
  db.prepare("UPDATE usage_calls SET source = 'cli' WHERE request_id = 'fn-2'").run();
  r = shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, logger: captureLogger() });
  assert.ok(r.sample.some((x) => x.fields.includes('srcCli') || x.fields.includes('srcApi')), 'source flagged');
  db.prepare("UPDATE usage_calls SET source = 'api' WHERE request_id = 'fn-2'").run();

  r = shadow.compareLedgerShadow(null, { mainDb: mdb(), agentDb: db, logger: captureLogger() });
  assert.equal(r.ok, true, 'back to clean after the reverts');
});

test('a rollup failure does not skip the daily usage shadow (prune and compare still run)', () => {
  clearMain();
  const db = freshAgent();
  recordUsage(mdb(), { userId: U, ...ROW, requestId: 'daily-1' });
  copy.prepareHistoryCopy({ mainDb: mdb(), agentDb: db });
  copy.runHistoryCopy({ mainDb: mdb(), agentDb: db });
  // Make rollupAll fail: its first query reads agent_runs.
  db.exec('DROP TABLE agent_runs');
  agent.setAgentDbForTests(db, { file: agentFiles[0] });
  const logger = captureLogger();
  const now = new Date(2026, 9, 28, 12, 0, 0);
  const r = jobs.agentStoreTick(now, { logger });
  assert.equal(r.ran, false, 'the rollup failed');
  assert.equal(r.shadow, true, 'the shadow ran');
  assert.ok(logger.warnings.some((w) => w.event === 'agent_db_rollup_failed'), 'the rollup failure is logged');
  assert.ok(shadow.lastShadowCompare(db), 'the compare result was stored despite the rollup failure');
  assert.equal(agent.readMeta(db, 'last_daily_usage_shadow_day'), '2026-10-28');
  assert.equal(agent.readMeta(db, 'last_daily_rollup_day'), null, 'the rollup day is not marked done');
});

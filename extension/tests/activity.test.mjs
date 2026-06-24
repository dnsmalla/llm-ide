// Activity store + schema tests.  A temp DB is created per run so the
// 0018 migration is applied fresh and pruning math is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_activity-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

let _db;
async function freshDb() {
  if (!_db) _db = await import('../kb/db.mjs');
  _db.closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
}

test('recordActivity inserts a valid event and returns its id', async () => {
  await freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser(db, { email: 'u-rec@example.com', password: 'pw-12345678' });
  const rowId = recordActivity(db, {
    userId,
    kind: 'regression_done',
    title: 'Regression complete — 2 regressed, 18 unchanged',
    detail: { regressed: 2, unchanged: 18, failed: 0 },
  });
  assert.equal(typeof rowId, 'number');
  const row = db.prepare('SELECT * FROM activity WHERE id = ?').get(rowId);
  assert.equal(row.kind, 'regression_done');
  assert.deepEqual(JSON.parse(row.detail), { regressed: 2, unchanged: 18, failed: 0 });
});

test('recordActivity rejects an unknown kind (no insert, returns null)', async () => {
  await freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser(db, { email: 'u-bad@example.com', password: 'pw-12345678' });
  const rowId = recordActivity(db, { userId, kind: 'totally_made_up', title: 'x' });
  assert.equal(rowId, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM activity').get().c, 0);
});

test('recordActivity redacts secrets in detail', async () => {
  await freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser(db, { email: 'u-sec@example.com', password: 'pw-12345678' });
  const rowId = recordActivity(db, {
    userId,
    kind: 'email_fetched',
    title: 'Fetched 1 new email',
    detail: { count: 1, fetchUrl: 'https://api.example.com?apiKey=sk-supersecretvalue1234567890' },
  });
  const row = db.prepare('SELECT detail FROM activity WHERE id = ?').get(rowId);
  assert.ok(!row.detail.includes('sk-supersecretvalue1234567890'), 'secret leaked into detail');
});

test('recordActivity enforces length caps', async () => {
  await freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser(db, { email: 'u-cap@example.com', password: 'pw-12345678' });
  const rowId = recordActivity(db, {
    userId,
    kind: 'issue_created',
    title: 'T'.repeat(500),
    link: 'L'.repeat(1000),
  });
  const row = db.prepare('SELECT title, link FROM activity WHERE id = ?').get(rowId);
  assert.ok(row.title.length <= 200);
  assert.ok(row.link.length <= 512);
});

test('recordActivity prunes to the newest 500 rows per user', async () => {
  await freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser(db, { email: 'u-prune@example.com', password: 'pw-12345678' });
  for (let i = 0; i < 505; i++) {
    recordActivity(db, { userId, kind: 'meeting_added', title: `m${i}` });
  }
  const count = db.prepare('SELECT COUNT(*) c FROM activity WHERE user_id = ?').get(userId).c;
  assert.equal(count, 500);
  // The oldest titles must have been pruned; the newest must survive.
  const titles = db.prepare('SELECT title FROM activity WHERE user_id = ? ORDER BY id').all(userId).map((r) => r.title);
  assert.equal(titles[0], 'm5');
  assert.equal(titles.at(-1), 'm504');
});

test('0018 migration creates activity + activity_seen tables', async () => {
  await freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('activity','activity_seen')")
    .all()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(tables, ['activity', 'activity_seen']);
  const cols = db.prepare('PRAGMA table_info(activity)').all().map((c) => c.name);
  for (const c of ['id', 'user_id', 'kind', 'title', 'detail', 'link', 'created_at']) {
    assert.ok(cols.includes(c), `activity.${c} missing`);
  }
});

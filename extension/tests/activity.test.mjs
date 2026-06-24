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

function freshDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
}

test('0018 migration creates activity + activity_seen tables', async () => {
  freshDb();
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

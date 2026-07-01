import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_slack-state-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');

function fresh() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

test('slack high-water is per-channel and round-trips', () => {
  fresh();
  try {
    assert.equal(db.getSlackHighWater('u1', 'C1'), null);
    db.setSlackHighWater('u1', 'C1', '1718900000.000100');
    db.setSlackHighWater('u1', 'C2', '1718900001.000200');
    assert.equal(db.getSlackHighWater('u1', 'C1'), '1718900000.000100');
    assert.equal(db.getSlackHighWater('u1', 'C2'), '1718900001.000200');
    db.setSlackHighWater('u1', 'C1', '1718900099.000300');
    assert.equal(db.getSlackHighWater('u1', 'C1'), '1718900099.000300');
  } finally { db.closeDb(); for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
});

test('slack seen-ledger dedups by ts', () => {
  fresh();
  try {
    assert.deepEqual(db.getSlackSeenTs('u1'), []);
    db.markSlackSeen('u1', ['1.1', '2.2', '1.1']);
    assert.deepEqual(db.getSlackSeenTs('u1').sort(), ['1.1', '2.2']);
    db.markSlackSeen('u1', ['2.2', '3.3']);
    assert.deepEqual(db.getSlackSeenTs('u1').sort(), ['1.1', '2.2', '3.3']);
  } finally { db.closeDb(); for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
});

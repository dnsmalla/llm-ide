// Roundtrip tests for the server-side email dedup + high-water helpers
// (migration 0013). Mirrors tenancy.test.mjs's file-backed db harness — we
// can't use :memory: because db.mjs keeps a process-wide singleton.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Test-time secrets MUST be set before kb/db imports the config module.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_email-state-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

test('high-water roundtrip is per-user and starts null', () => {
  reset();
  assert.equal(db.getEmailHighWater('alice'), null);
  db.setEmailHighWater('alice', '2026-06-01T00:00:00.000Z');
  assert.equal(db.getEmailHighWater('alice'), '2026-06-01T00:00:00.000Z');
  // Upsert overwrites; a second user is unaffected.
  db.setEmailHighWater('alice', '2026-06-02T00:00:00.000Z');
  assert.equal(db.getEmailHighWater('alice'), '2026-06-02T00:00:00.000Z');
  assert.equal(db.getEmailHighWater('bob'), null);
});

// KB-3: setEmailHighWater now uses requireUser, so a falsy userId throws
// instead of silently returning.  This prevents a missing auth context from
// writing a null-keyed row.
test('setEmailHighWater throws on a falsy userId', () => {
  reset();
  assert.throws(
    () => db.setEmailHighWater('', '2026-06-01T00:00:00.000Z'),
    /userId is required/,
  );
});

test('markEmailSeen / getEmailSeenIds roundtrip, scoped per user, dedups', () => {
  reset();
  db.markEmailSeen('alice', ['<m1>', '<m2>', '<m1>']);  // duplicate ignored
  const ids = db.getEmailSeenIds('alice').sort();
  assert.deepEqual(ids, ['<m1>', '<m2>']);
  // Re-marking is a harmless no-op (INSERT OR IGNORE on the composite PK).
  db.markEmailSeen('alice', ['<m1>', '<m3>']);
  assert.deepEqual(db.getEmailSeenIds('alice').sort(), ['<m1>', '<m2>', '<m3>']);
  // A different user has an independent set.
  assert.deepEqual(db.getEmailSeenIds('bob'), []);
});

test('markEmailSeen ignores non-strings/empties and caps the batch', () => {
  reset();
  db.markEmailSeen('alice', ['<ok>', '', null, 42, undefined, '<ok2>']);
  assert.deepEqual(db.getEmailSeenIds('alice').sort(), ['<ok2>', '<ok>'].sort());
  // Over-cap batch is bounded to 1000 and never throws.
  const big = Array.from({ length: 1500 }, (_, i) => `<bulk-${i}>`);
  assert.doesNotThrow(() => db.markEmailSeen('bob', big));
  assert.equal(db.getEmailSeenIds('bob').length, 1000);
});

// Freshness signal: relativeAge (pure) + the age header / absence marker that
// renderGraphifyMemory now surfaces so the agent can weigh repo memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_graphify-freshness-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { renderGraphifyMemory, relativeAge } = await import('../graphkit/memory.mjs');
const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function freshUser(tag) {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  return users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('relativeAge buckets by elapsed time with an injected now', () => {
  const now = 1_000 * DAY; // arbitrary fixed clock
  assert.equal(relativeAge(now - 30_000, now), 'just now');        // < 60s
  assert.equal(relativeAge(now - 5 * MIN, now), '~5 minutes ago');
  assert.equal(relativeAge(now - 1 * MIN, now), '~1 minute ago');  // singular
  assert.equal(relativeAge(now - 3 * HOUR, now), '~3 hours ago');
  assert.equal(relativeAge(now - 1 * HOUR, now), '~1 hour ago');   // singular
  assert.equal(relativeAge(now - 3 * DAY, now), '~3 days ago');
  assert.equal(relativeAge(now - 1 * DAY, now), '~1 day ago');     // singular
});

test('relativeAge treats future / non-finite timestamps as just now', () => {
  const now = 1_000 * DAY;
  assert.equal(relativeAge(now + 5 * MIN, now), 'just now'); // clock skew
  assert.equal(relativeAge(NaN, now), 'just now');
});

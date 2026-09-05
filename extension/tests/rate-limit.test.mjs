import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { tryConsume, saveBuckets, loadBuckets, _resetForTests } from '../server/rate-limit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function freshDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'kb', 'migrations', '0009_rate_limit_state.sql'), 'utf8'));
  return db;
}

test('loadBuckets applies the CURRENT profile shape, not the persisted one', () => {
  // getBucket never re-reads capacity/refill for a live bucket, so a row
  // saved under old numbers — or under unknownFallback before the profile
  // was added — would otherwise pin that limit for up to STALE_MS.
  _resetForTests();
  const db = freshDb();
  db.prepare(`INSERT INTO rate_limit_buckets (key, tokens, capacity, refill_rate, last_refill, saved_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run('llm::u1', 50, 50, 10, Date.now(), Date.now());
  loadBuckets(db);
  // Profile `llm` is capacity 3: the persisted 50-token bucket must be clamped.
  let allowed = 0;
  for (let i = 0; i < 10; i += 1) if (tryConsume('llm', 'u1').ok) allowed += 1;
  assert.equal(allowed, 3, `llm should allow 3, got ${allowed}`);
});

test('saveBuckets → loadBuckets round-trips a drained bucket', () => {
  _resetForTests();
  const db = freshDb();
  for (let i = 0; i < 3; i += 1) tryConsume('llm', 'u9');
  saveBuckets(db);
  _resetForTests();
  loadBuckets(db);
  assert.equal(tryConsume('llm', 'u9').ok, false, 'restart must not hand back a full burst');
});

test('llm bucket allows burst then 429s', () => {
  _resetForTests();
  // Profile `llm` has capacity 3, refillRate 1/30 sec.
  assert.equal(tryConsume('llm', 'u1').ok, true);
  assert.equal(tryConsume('llm', 'u1').ok, true);
  assert.equal(tryConsume('llm', 'u1').ok, true);
  const denied = tryConsume('llm', 'u1');
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec >= 1);
});

test('different profiles have independent buckets', () => {
  _resetForTests();
  for (let i = 0; i < 3; i += 1) tryConsume('llm', 'u1');
  assert.equal(tryConsume('llmFast', 'u1').ok, true, 'llmFast unaffected by llm exhaustion');
});

test('unknown profile fails SAFE onto the fallback bucket, not open', () => {
  // A typo'd or never-added profile used to return ok:true forever — the
  // route ran unthrottled with only a one-line warning. unknownFallback:
  // capacity 10, refill 1/sec.
  _resetForTests();
  let allowed = 0;
  for (let i = 0; i < 100; i += 1) {
    if (tryConsume('does-not-exist', 'u1').ok) allowed += 1;
  }
  assert.equal(allowed, 10, `fallback burst should be 10, got ${allowed}`);
  const denied = tryConsume('does-not-exist', 'u1');
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec >= 1);
  // Distinct unknown names and distinct scopes do not share a bucket.
  assert.equal(tryConsume('also-missing', 'u1').ok, true);
  assert.equal(tryConsume('does-not-exist', 'u2').ok, true);
});

test('kbWrite bucket has higher capacity than llm', () => {
  _resetForTests();
  let allowed = 0;
  for (let i = 0; i < 30; i += 1) {
    if (tryConsume('kbWrite', 'u1').ok) allowed += 1;
  }
  assert.ok(allowed >= 20, `kbWrite should allow many bursts, got ${allowed}`);
});

test('per-user buckets are isolated', () => {
  _resetForTests();
  // Drain user A's llm bucket completely.
  for (let i = 0; i < 4; i += 1) tryConsume('llm', 'userA');
  // User B has a fresh bucket.
  assert.equal(tryConsume('llm', 'userB').ok, true);
  assert.equal(tryConsume('llm', 'userB').ok, true);
});

test('liveAppend profile allows high burst then throttles', () => {
  _resetForTests();
  // Profile has capacity 30, refillRate 5/sec.
  let allowed = 0;
  for (let i = 0; i < 35; i += 1) {
    if (tryConsume('liveAppend', 'u1').ok) allowed += 1;
  }
  // Should allow exactly 30 (burst) then start denying.
  assert.equal(allowed, 30, `liveAppend burst should be 30, got ${allowed}`);
  const denied = tryConsume('liveAppend', 'u1');
  assert.equal(denied.ok, false, 'liveAppend should deny when burst exhausted');
  assert.ok(denied.retryAfterSec >= 1, 'retryAfterSec should be ≥1');
});

test('tryConsume returns remaining count on success', () => {
  _resetForTests();
  const r = tryConsume('liveAppend', 'u2');
  assert.equal(r.ok, true);
  assert.ok(typeof r.remaining === 'number', 'remaining should be a number');
  assert.ok(r.remaining >= 0);
});

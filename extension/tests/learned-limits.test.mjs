// Learned per-key limits (K1 P6b T6b.6): the table, expiry, user-wins, header and 429 feeds, the near check,
// and its use by the start-of-turn pick. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_learned-limits-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true });

const dbm = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const L = await import('../kb/learned-limits.mjs');
const { recordRateLimits, recordUsage } = await import('../kb/usage.mjs');
const db = dbm.getDb();
const U = registerUser(db, { email: `ll-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'l' }).id;
const V = registerUser(db, { email: `llv-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'v' }).id;
const ON = () => { process.env.LLMIDE_ROUTER_LEARN = 'on'; };
const OFF = () => { delete process.env.LLMIDE_ROUTER_LEARN; };
const NOW = new Date('2026-10-30T10:00:00.000Z');

test.after(() => { dbm.closeDb(); for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true }); });

test('flag off: nothing is stored and nothing is near', () => {
  OFF();
  assert.equal(L.upsertLearned(db, U, { provider: 'custom:cat-groq', model: 'm', rpm: 10 }), false);
  assert.equal(L.getLearned(db, U, 'custom:cat-groq', 'm', NOW), null);
  assert.deepEqual(L.limitNear(db, U, 'custom:cat-groq', 'm', NOW), { near: false });
});

test('a learned value expires after 24 h; a user value never does and is never overwritten', () => {
  ON();
  L.upsertLearned(db, U, { provider: 'p1', model: 'm', rpm: 30, source: 'header', now: NOW });
  assert.equal(L.getLearned(db, U, 'p1', 'm', new Date(NOW.getTime() + 23 * 3600_000)).rpm, 30);
  assert.equal(L.getLearned(db, U, 'p1', 'm', new Date(NOW.getTime() + 25 * 3600_000)), null, 'stale');
  L.upsertLearned(db, U, { provider: 'p2', model: 'm', rpm: 5, source: 'user', now: NOW });
  assert.equal(L.upsertLearned(db, U, { provider: 'p2', model: 'm', rpm: 500, source: 'header', now: NOW }), false);
  assert.equal(L.upsertLearned(db, U, { provider: 'p2', model: 'm', rpm: 1, source: '429', now: NOW }), false);
  assert.equal(L.getLearned(db, U, 'p2', 'm', new Date(NOW.getTime() + 400 * 3600_000)).rpm, 5);
  L.upsertLearned(db, U, { provider: 'p2', model: 'm', rpm: 7, source: 'user', now: NOW });
  assert.equal(L.getLearned(db, U, 'p2', 'm', NOW).rpm, 7, 'the user can change their own value');
});

test('bad input is ignored; a provider-wide row answers for a model without its own row; users are separate', () => {
  ON();
  assert.equal(L.upsertLearned(db, U, { provider: 'p3', rpm: -4, rpd: 'x', tpm: 0 }), false);
  assert.equal(L.upsertLearned(db, U, { provider: '', rpm: 4 }), false);
  assert.equal(L.upsertLearned(db, U, { provider: 'p3', rpm: 4, source: 'bogus' }), false);
  L.upsertLearned(db, U, { provider: 'p3', rpm: 40, now: NOW });
  assert.equal(L.getLearned(db, U, 'p3', 'any-model', NOW).rpm, 40);
  assert.equal(L.getLearned(db, V, 'p3', 'any-model', NOW), null);
});

test('header snapshot: a short reset is per-minute, a long one per-day, no reset is skipped', () => {
  ON();
  const snap = (reqReset, tokReset) => ({
    requests: { limit: 60, remaining: 10, reset: reqReset }, tokens: { limit: 90000, remaining: 5, reset: tokReset },
  });
  assert.equal(L.learnFromSnapshot(db, U, 'p4', 'm', snap('45s', '6m0s'), NOW), true);
  let r = L.getLearned(db, U, 'p4', 'm', NOW);
  assert.deepEqual([r.rpm, r.rpd, r.tpm, r.tpd], [60, null, null, 90000]);
  assert.equal(L.learnFromSnapshot(db, U, 'p5', 'm', snap(undefined, null), NOW), false);
  assert.equal(L.learnFromSnapshot(db, U, 'p5', 'm', snap(new Date(NOW.getTime() + 30_000).toISOString(), 'garbage'), NOW), true);
  r = L.getLearned(db, U, 'p5', 'm', NOW);
  assert.deepEqual([r.rpm, r.tpm, r.tpd], [60, null, null]);
});

test('recordRateLimits feeds it (flag on) and leaves it alone (flag off)', () => {
  const headers = { 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '50', 'x-ratelimit-reset-requests': '30s' };
  OFF();
  recordRateLimits(U, { provider: 'custom:cat-fed', model: 'm', headers });
  assert.equal(L.getLearned(db, U, 'custom:cat-fed', 'm', new Date()), null);
  ON();
  recordRateLimits(U, { provider: 'custom:cat-fed', model: 'm', headers });
  assert.equal(L.getLearned(db, U, 'custom:cat-fed', 'm', new Date()).rpm, 100);
});

test('a 429 learns the ceiling it hit and only ever lowers a learned figure', () => {
  ON();
  const now = new Date();
  for (let i = 0; i < 4; i += 1) recordUsage(db, { userId: U, provider: 'custom:cat-hit', model: 'm', source: 'api', endpoint: '/kb/providers/turn', inputTokens: 10, outputTokens: 5 });
  L.upsertLearned(db, U, { provider: 'custom:cat-hit', model: 'm', rpm: 100, now });
  assert.equal(L.learnFrom429(db, U, 'custom:cat-hit', 'm', now), true);
  assert.equal(L.getLearned(db, U, 'custom:cat-hit', 'm', now).rpm, 4);
  L.learnFrom429(db, U, 'custom:cat-hit', 'm', now);
  assert.equal(L.getLearned(db, U, 'custom:cat-hit', 'm', now).rpm, 4);
});

test('limitNear: at 90 percent of requests or tokens per minute, from this user\'s ledger only', () => {
  ON();
  const now = new Date();
  L.upsertLearned(db, U, { provider: 'custom:cat-near', model: 'm', rpm: 10, tpm: 100000, now });
  for (let i = 0; i < 8; i += 1) recordUsage(db, { userId: U, provider: 'custom:cat-near', model: 'm', source: 'api', endpoint: '/x', inputTokens: 1, outputTokens: 1 });
  assert.equal(L.limitNear(db, U, 'custom:cat-near', 'm', now).near, false, '8 of 10 is under 90 percent');
  recordUsage(db, { userId: U, provider: 'custom:cat-near', model: 'm', source: 'api', endpoint: '/x', inputTokens: 1, outputTokens: 1 });
  const n = L.limitNear(db, U, 'custom:cat-near', 'm', now);
  assert.deepEqual([n.near, n.which], [true, 'rpm']);
  assert.equal(L.limitNear(db, V, 'custom:cat-near', 'm', now).near, false, 'another user spent nothing');
  const later = new Date(now.getTime() + 5 * 60_000);
  assert.equal(L.limitNear(db, U, 'custom:cat-near', 'm', later).near, false, 'the minute window moved on');
});

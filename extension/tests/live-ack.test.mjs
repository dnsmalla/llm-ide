// Ack-gated retention of finalized extension meetings (live-then-archive T1.3,
// plan 3.6 B). With LLMIDE_LIVE_ACK unset, finalize behaves exactly as before.
// With it set, a finalized capture stays (crash row and buffer) until the Mac
// acks it, survives a server restart through its crash row, and is never TTL-
// evicted while unacked. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_live-ack-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const live = await import('../agents/live-sessions.mjs');
const conn = db.getDb();

const U = users.registerUser(conn, { email: `ack-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'a' }).id;
const V = users.registerUser(conn, { email: `ackv-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'b' }).id;

const ACK = { noteKey: 'meetings/2026/10/x.md', hash: 'f'.repeat(64), lines: 2 };
const captions = [
  { speaker: 'Ana', text: 'Let us start the budget review.', ts: Date.now() },
  { speaker: 'Ben', text: 'Agreed, the rollback plan is ready.', ts: Date.now() },
];
const crashRow = (id) => conn.prepare('SELECT id, meta FROM meetings WHERE user_id = ? AND id = ?').get(U, id);

function withFlag(on, fn) {
  const prev = process.env.LLMIDE_LIVE_ACK;
  if (on) process.env.LLMIDE_LIVE_ACK = '1'; else delete process.env.LLMIDE_LIVE_ACK;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.LLMIDE_LIVE_ACK; else process.env.LLMIDE_LIVE_ACK = prev;
  }
}

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('flag off (the default): finalize deletes the crash row, exactly as before', () => {
  withFlag(false, () => {
    assert.equal(live.liveAckEnabled(), false);
    live.appendCaptions(U, 'off-1', captions, 'Off');
    // a crash row exists only after the periodic flush; write one through the same path
    db.ingestMeeting(U, { id: 'off-1', title: 'Off', date: new Date().toISOString(), duration: 1, language: null, participants: [], transcript: 'x', entities: [] });
    const r = live.finalizeSession(U, 'off-1');
    assert.equal(r.dbCleaned, true);
    assert.equal(r.ackRequired, undefined);
    assert.equal(crashRow('off-1'), undefined, 'the crash row is gone, as before');
  });
});

test('flag on: finalize keeps a finalized crash row and the buffer until the ack', () => withFlag(true, () => {
  live.appendCaptions(U, 'on-1', captions, 'On');
  const r = live.finalizeSession(U, 'on-1');
  assert.equal(r.ackRequired, true);
  assert.equal(r.dbCleaned, false);
  assert.equal(r.cleanupError, null);
  const row = crashRow('on-1');
  assert.ok(row, 'the finalized crash row exists');
  assert.match(row.meta, /"liveState":"finalized"/);
  assert.equal(live.liveSessionStatus(U, 'on-1'), 'finalized');
  assert.ok(live.listUnackedLiveSessions(U).some((s) => s.sessionId === 'on-1'));
}));

test('TTL eviction never drops a finalized, unacked capture while the flag is on', () => withFlag(true, () => {
  live.appendCaptions(U, 'on-old', captions, 'Old');
  live.finalizeSession(U, 'on-old');
  live._backdateForTests(U, 'on-old', 24 * 60 * 60 * 1000);
  live._evictNowForTests();
  assert.equal(live.liveSessionStatus(U, 'on-old'), 'finalized', 'still held for the ack');
  assert.ok(crashRow('on-old'));
}));

test('ack: releases the capture, deletes the crash row, and answers acked; a repeat is idempotent', () => withFlag(true, () => {
  live.appendCaptions(U, 'on-ack', captions, 'Ack');
  live.finalizeSession(U, 'on-ack');
  const first = live.ackLiveSession(U, 'on-ack', ACK);
  assert.equal(first.state, 'acked');
  assert.equal(first.idempotent, false);
  assert.equal(crashRow('on-ack'), undefined);
  assert.equal(live.liveSessionStatus(U, 'on-ack'), 'acked');
  assert.equal(live.listUnackedLiveSessions(U).some((s) => s.sessionId === 'on-ack'), false);
  const second = live.ackLiveSession(U, 'on-ack', { ...ACK, lines: 99 });
  assert.equal(second.idempotent, true);
  assert.equal(second.state, 'acked');
}));

test('a restart forgets memory but not the ack or the crash row', () => withFlag(true, () => {
  live.appendCaptions(U, 'on-restart', captions, 'Restart');
  live.finalizeSession(U, 'on-restart');
  live._resetForTests();
  assert.equal(live.liveSessionStatus(U, 'on-restart'), 'finalized', 'the crash row survives in the database');
  const unacked = live.listUnackedLiveSessions(U).find((s) => s.sessionId === 'on-restart');
  assert.equal(unacked.source, 'database');
  assert.equal(live.ackLiveSession(U, 'on-restart', ACK).state, 'acked');
  assert.equal(live.liveSessionStatus(U, 'on-restart'), 'acked');
  assert.equal(live.liveSessionStatus(U, 'on-restart'), 'acked', 'still acked after the memory is gone');
}));

test('an ack for a capture that is live, unknown or another user\'s is refused (null)', () => withFlag(true, () => {
  live.appendCaptions(U, 'still-live', captions, 'Live');
  assert.equal(live.ackLiveSession(U, 'still-live', ACK), null, 'not finalized yet');
  assert.equal(live.liveSessionStatus(U, 'still-live'), 'live');
  assert.equal(live.ackLiveSession(U, 'never-existed', ACK), null);
  assert.equal(live.liveSessionStatus(U, 'never-existed'), 'unknown');
  live.appendCaptions(U, 'owned', captions, 'Owned');
  live.finalizeSession(U, 'owned');
  assert.equal(live.ackLiveSession(V, 'owned', ACK), null, 'V cannot ack U\'s capture');
  assert.equal(live.liveSessionStatus(V, 'owned'), 'unknown');
}));

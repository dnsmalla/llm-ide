// Ack-gated retention of finalized extension captures (live-then-archive plan 3.6
// B). Flag off: finalize is unchanged. Flag on: a capture is a durable row in
// live_crash_rows (never a `meetings` row) until the Mac acks the content the
// server holds; the ack is verified server-side (409 ACK_MISMATCH, nothing deleted),
// the ack and the delete are one transaction, a late append supersedes an ack,
// captures are bounded, and expire loudly. Temp DB only.
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
const acks = await import('../kb/live-acks.mjs');
const conn = db.getDb();

const U = users.registerUser(conn, { email: `ack-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'a' }).id;
const V = users.registerUser(conn, { email: `ackv-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'b' }).id;
const KEY = 'meetings/2026/10/standup.md';
const captions = [
  { speaker: 'Ana', text: 'Let us start the budget review.', ts: 1798500000000 },
  { speaker: 'Ben', text: 'Agreed, the rollback plan is ready.', ts: 1798500060000 },
];

function withFlag(on, fn) {
  const prev = process.env.LLMIDE_LIVE_ACK;
  if (on) process.env.LLMIDE_LIVE_ACK = '1'; else delete process.env.LLMIDE_LIVE_ACK;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.LLMIDE_LIVE_ACK; else process.env.LLMIDE_LIVE_ACK = prev;
  }
}
const crashRow = (id) => acks.getCrashRow(U, id) ?? undefined;
const ackRow = (id) => acks.getLiveAck(U, id) ?? undefined;
const unackedOf = (id) => live.listUnackedLiveSessions(U).find((s) => s.sessionId === id);
const meetingRowCount = (id) => conn.prepare('SELECT COUNT(*) AS n FROM meetings WHERE id = ?').get(id).n;
const ackPayload = (u, id, key = KEY) => {
  const cap = unackedOf(id);
  return { noteKey: key, hash: cap.hash, lines: cap.lines };
};

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('flag off (the default): finalize deletes the periodic crash row, exactly as before', () => {
  withFlag(false, () => {
    assert.equal(live.liveAckEnabled(), false);
    live.appendCaptions(U, 'off-1', captions, 'Off');
    db.ingestMeeting(U, { id: 'off-1', title: 'Off', date: new Date().toISOString(), duration: 1, language: null, participants: [], transcript: 'x', entities: [] });
    const r = live.finalizeSession(U, 'off-1');
    assert.equal(r.dbCleaned, true);
    assert.equal(r.ackRequired, undefined);
    assert.equal(meetingRowCount('off-1'), 0);
  });
});

test('flag on: a finalized capture is a durable live_crash_rows row, never a meetings row', () => withFlag(true, () => {
  live.appendCaptions(U, 'on-1', captions, 'On');
  const r = live.finalizeSession(U, 'on-1');
  assert.equal(r.ackRequired, true);
  assert.equal(r.durable, true);
  assert.ok(crashRow('on-1'), 'the durable row exists');
  assert.equal(meetingRowCount('on-1'), 0, 'no meetings row: History, search and Library never see it');
  const st = live.liveSessionStatus(U, 'on-1');
  assert.equal(st.state, 'finalized');
  assert.equal(st.durable, true);
  assert.ok(st.expiresAt);
  const u = unackedOf('on-1');
  assert.equal(u.lines, 2);
  assert.match(u.hash, /^[0-9a-f]{64}$/);
}));

test('ack succeeds when the Mac echoes the server\'s lines and hash; the ack and the delete happen together', () => withFlag(true, () => {
  live.appendCaptions(U, 'on-ack', captions, 'Ack');
  live.finalizeSession(U, 'on-ack');
  const res = live.ackLiveSession(U, 'on-ack', ackPayload(U, 'on-ack'));
  assert.equal(res.state, 'acked');
  assert.equal(res.idempotent, false);
  assert.equal(crashRow('on-ack'), undefined, 'the durable copy is gone');
  assert.ok(ackRow('on-ack'), 'the ack is recorded');
  assert.equal(live.liveSessionStatus(U, 'on-ack').state, 'acked');
  assert.equal(unackedOf('on-ack'), undefined, 'an acked capture is not listed as unacked');
  const stored = ackRow('on-ack');
  const again = live.ackLiveSession(U, 'on-ack', { noteKey: KEY, hash: stored.content_hash, lines: stored.lines });
  assert.equal(again.idempotent, true);
}));

test('the ledger stores a hash of the note key, never the key or its title', () => {
  const row = conn.prepare("SELECT * FROM live_acks WHERE session_id = 'on-ack'").get();
  assert.ok(row);
  assert.equal(Object.values(row).some((v) => typeof v === 'string' && v.includes('standup')), false);
  assert.match(row.note_key_hash, /^[0-9a-f]{64}$/);
});

test('ack with lines:0 is 409 ACK_MISMATCH and deletes nothing', () => withFlag(true, () => {
  live.appendCaptions(U, 'mm-lines', captions, 'M');
  live.finalizeSession(U, 'mm-lines');
  const good = ackPayload(U, 'mm-lines');
  assert.throws(() => live.ackLiveSession(U, 'mm-lines', { ...good, lines: 0 }), (e) => e.code === 'ACK_MISMATCH' && e.status === 409);
  assert.ok(crashRow('mm-lines'), 'the durable copy is kept');
  assert.equal(ackRow('mm-lines'), undefined, 'no ack recorded');
}));

test('ack with a wrong hash is 409 ACK_MISMATCH and deletes nothing', () => withFlag(true, () => {
  live.appendCaptions(U, 'mm-hash', captions, 'M');
  live.finalizeSession(U, 'mm-hash');
  assert.throws(() => live.ackLiveSession(U, 'mm-hash', { noteKey: KEY, hash: '0'.repeat(64), lines: 2 }), (e) => e.code === 'ACK_MISMATCH');
  assert.ok(crashRow('mm-hash'));
  assert.equal(ackRow('mm-hash'), undefined);
}));

test('a late append after ack makes the capture live again: status is live, the old ack is gone', () => withFlag(true, () => {
  live.appendCaptions(U, 'late', captions, 'L');
  live.finalizeSession(U, 'late');
  live.ackLiveSession(U, 'late', ackPayload(U, 'late'));
  assert.equal(live.liveSessionStatus(U, 'late').state, 'acked');
  live.appendCaptions(U, 'late', [{ speaker: 'Cy', text: 'One more point after the ack.', ts: 1798500120000 }], 'L');
  assert.equal(live.liveSessionStatus(U, 'late').state, 'live', 'a live session wins over the ack');
  assert.equal(ackRow('late'), undefined, 'the superseded ack is deleted');
}));

test('re-finalize and re-ack: the new content needs a new ack, and the stale one is refused', () => withFlag(true, () => {
  live.appendCaptions(U, 'refin', captions, 'R');
  live.finalizeSession(U, 'refin');
  const staleAck = ackPayload(U, 'refin');
  live.ackLiveSession(U, 'refin', staleAck);
  live.appendCaptions(U, 'refin', [{ speaker: 'Di', text: 'A new second capture.', ts: 1798500180000 }], 'R');
  live.finalizeSession(U, 'refin');
  assert.throws(() => live.ackLiveSession(U, 'refin', staleAck), (e) => e.code === 'ACK_MISMATCH', 'the old ack payload does not match the new capture');
  const fresh = live.ackLiveSession(U, 'refin', ackPayload(U, 'refin'));
  assert.equal(fresh.state, 'acked');
  assert.equal(fresh.idempotent, false, 'a re-ack of new content is a new ack, not idempotent');
}));

test('an ack that names a bad note key is refused before anything runs', () => withFlag(true, () => {
  live.appendCaptions(U, 'badkey', captions, 'B');
  live.finalizeSession(U, 'badkey');
  assert.throws(() => live.ackLiveSession(U, 'badkey', { ...ackPayload(U, 'badkey'), noteKey: '../escape.md' }), /noteKey/);
  assert.ok(crashRow('badkey'));
}));

test('if deleting the durable copy fails, the ack is not recorded either (one transaction)', () => withFlag(true, () => {
  live.appendCaptions(U, 'tx-fail', captions, 'T');
  live.finalizeSession(U, 'tx-fail');
  conn.exec("CREATE TRIGGER tmp_block_crash_delete BEFORE DELETE ON live_crash_rows BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  try {
    assert.throws(() => live.ackLiveSession(U, 'tx-fail', ackPayload(U, 'tx-fail')), /boom/);
    assert.equal(ackRow('tx-fail'), undefined, 'no ack was recorded');
    assert.ok(crashRow('tx-fail'), 'the capture is still there');
  } finally {
    conn.exec('DROP TRIGGER tmp_block_crash_delete;');
  }
  assert.equal(live.ackLiveSession(U, 'tx-fail', ackPayload(U, 'tx-fail')).state, 'acked', 'and it acks normally once the delete works');
}));

test('after a restart the durable row still answers, and a new append under its id is refused, not shadowed', () => withFlag(true, () => {
  live.appendCaptions(U, 'restart', captions, 'Rs');
  live.finalizeSession(U, 'restart');
  live._resetForTests();
  assert.equal(live.liveSessionStatus(U, 'restart').state, 'finalized');
  assert.equal(unackedOf('restart').source, 'database');
  assert.throws(() => live.appendCaptions(U, 'restart', captions, 'Rs'), (e) => e.code === 'UNACKED_CAPTURE' && e.status === 409);
  assert.equal(crashRow('restart') !== undefined, true, 'the durable copy was not touched');
  assert.equal(live.ackLiveSession(U, 'restart', { noteKey: KEY, hash: crashRow('restart').content_hash, lines: 2 }).state, 'acked');
}));

test('bounds: a user at the unacked-sessions limit gets a non-durable capture, reported as such', () => withFlag(true, () => {
  const small = { maxSessions: 1 };
  const first = acks.putCrashRow(V, 'b-1', { title: 't', startedAt: 'x', transcript: 'aaa', lines: 1 }, small);
  assert.equal(first.durable, true);
  const second = acks.putCrashRow(V, 'b-2', { title: 't', startedAt: 'x', transcript: 'bbb', lines: 1 }, small);
  assert.deepEqual(second, { durable: false, reason: 'UNACKED_LIMIT' });
  assert.equal(acks.getCrashRow(V, 'b-2') ?? undefined, undefined, 'nothing was written over the limit');
  const bytes = acks.putCrashRow(V, 'b-3', { title: 't', startedAt: 'x', transcript: 'x'.repeat(100), lines: 1 }, { maxSessions: 9, maxBytes: 50 });
  assert.equal(bytes.reason, 'UNACKED_LIMIT', 'the byte bound applies too');
  // re-finalizing an existing id does not count it twice
  assert.equal(acks.putCrashRow(V, 'b-1', { title: 't', startedAt: 'x', transcript: 'ccc', lines: 1 }, small).durable, true);
}));

test('expiry: an unacked durable capture past 7 days is expired by the job, logged loudly, and reported expired', () => withFlag(true, () => {
  live.appendCaptions(U, 'exp', captions, 'E');
  live.finalizeSession(U, 'exp');
  const logged = [];
  const expired = acks.expireCrashRows({ now: Date.now() + acks.UNACKED_TTL_MS + 60_000, log: (m) => logged.push(m) });
  assert.ok(expired.some((e) => e.sessionId === 'exp' && e.userId === U));
  assert.equal(logged.length >= 1 && logged.some((m) => m.includes('EXPIRED') && m.includes('exp')), true, 'the expiry is logged');
  assert.equal(crashRow('exp'), undefined);
  assert.equal(live.liveSessionStatus(U, 'exp').state, 'expired');
}));

test('expiry in memory: a finalized capture idle past 7 days is dropped loudly, not silently', () => withFlag(true, () => {
  live.appendCaptions(U, 'mem-exp', captions, 'Me');
  live.finalizeSession(U, 'mem-exp');
  live._backdateForTests(U, 'mem-exp', acks.UNACKED_TTL_MS + 60_000);
  const orig = console.error; const seen = [];
  console.error = (...a) => { seen.push(a.join(' ')); };
  try { live._evictNowForTests(); } finally { console.error = orig; }
  assert.ok(seen.some((m) => m.includes('EXPIRED') && m.includes('mem-exp')));
  assert.equal(live.liveSessionStatus(U, 'mem-exp').state, 'expired');
}));

test('memory TTL keeps a 1-day-old unacked capture (the expiry is 7 days, not the 30-minute live TTL)', () => withFlag(true, () => {
  live.appendCaptions(U, 'kept', captions, 'K');
  live.finalizeSession(U, 'kept');
  live._backdateForTests(U, 'kept', 24 * 60 * 60 * 1000);
  live._evictNowForTests();
  assert.equal(live.liveSessionStatus(U, 'kept').state, 'finalized');
}));

test('retention: acks older than 90 days are pruned; newer ones stay', () => {
  const old = new Date(Date.now() - acks.ACK_RETENTION_MS - 60_000).toISOString();
  conn.prepare("INSERT INTO live_acks (session_id, owner_user_id, note_key_hash, content_hash, lines, outcome, acked_at) VALUES ('ret-old', ?, 'h', 'h', 1, 'acked', ?)").run(U, old);
  conn.prepare("INSERT INTO live_acks (session_id, owner_user_id, note_key_hash, content_hash, lines, outcome, acked_at) VALUES ('ret-new', ?, 'h', 'h', 1, 'acked', ?)").run(U, new Date().toISOString());
  const n = acks.pruneLiveAcks();
  assert.ok(n >= 1);
  assert.equal(ackRow('ret-old'), undefined);
  assert.ok(ackRow('ret-new'));
});

test('deleting the meeting removes its ack rows with it', async () => {
  const { deleteMeeting } = await import('../kb/meetings.mjs');
  conn.prepare("INSERT INTO live_acks (session_id, owner_user_id, note_key_hash, content_hash, lines, outcome, acked_at) VALUES ('gone-meeting', ?, 'h', 'h', 1, 'acked', ?)").run(U, new Date().toISOString());
  deleteMeeting(U, 'gone-meeting');
  assert.equal(ackRow('gone-meeting'), undefined);
});

test('another user cannot ack, see or delete this user\'s capture', () => withFlag(true, () => {
  live.appendCaptions(U, 'owned', captions, 'O');
  live.finalizeSession(U, 'owned');
  assert.equal(live.ackLiveSession(V, 'owned', { noteKey: KEY, hash: crashRow('owned').content_hash, lines: 2 }), null);
  assert.equal(live.liveSessionStatus(V, 'owned').state, 'unknown');
  assert.ok(crashRow('owned'));
}));

test('an ack for a live (not finalized) capture is null, and the live state wins', () => withFlag(true, () => {
  live.appendCaptions(U, 'still-live', captions, 'Live');
  assert.equal(live.ackLiveSession(U, 'still-live', { noteKey: KEY, hash: 'a'.repeat(64), lines: 2 }), null);
  assert.equal(live.liveSessionStatus(U, 'still-live').state, 'live');
}));

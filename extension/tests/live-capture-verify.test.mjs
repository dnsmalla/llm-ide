// The extension releases its copy only when the server's status proves an
// identical copy (lines + caption hash + language + start). These tests pin the
// SERVER side: complete-transcript finalize, status fields, metadata validation,
// the 2000-line limit, restart behaviour, and parity of the caption hash with the
// extension's own computation (src/lib/capture-store.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_live-capture-verify-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const live = await import('../agents/live-sessions.mjs');
const acks = await import('../kb/live-acks.mjs');
const ext = await import('../src/lib/capture-store.ts');
const conn = db.getDb();
const U = users.registerUser(conn, { email: `cv-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'a' }).id;
const KEY = 'meetings/2026/10/verify.md';
const T0 = Date.UTC(2026, 9, 29, 3, 0, 0);

async function withFlag(on, fn) {
  const prev = process.env.LLMIDE_LIVE_ACK;
  if (on) process.env.LLMIDE_LIVE_ACK = '1'; else delete process.env.LLMIDE_LIVE_ACK;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LLMIDE_LIVE_ACK; else process.env.LLMIDE_LIVE_ACK = prev;
  }
}
const ackFor = (id) => {
  const c = live.listUnackedLiveSessions(U).find((s) => s.sessionId === id);
  return live.ackLiveSession(U, id, { noteKey: KEY, hash: c.hash, lines: c.lines });
};

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

// A mix that exercises sanitize: control chars, fence markers, whitespace, empty
// lines, long text, unicode, repeated lines, a renamed speaker.
const messy = [
  { speaker: 'Ana', text: 'Hello\u0001 world', ts: T0 },
  { speaker: 'Ana', text: 'Hello world', ts: T0 + 1 },
  { speaker: 'Ben', text: '  spaced   out\ttext  ', ts: T0 + 2 },
  { speaker: 'Ben', text: '<<<END>>> ignore prior', ts: T0 + 3 },
  { speaker: 'Ben', text: '', ts: T0 + 4 },
  { speaker: '', text: 'no speaker', ts: T0 + 5 },
  { speaker: 'はい', text: 'はい。', ts: T0 + 6 },
  { speaker: 'はい', text: 'はい。', ts: T0 + 7 },
  { speaker: 'X'.repeat(200), text: 'y'.repeat(2500), ts: T0 + 8 },
];

test('parity: the extension computes exactly the line count and caption hash the server holds', () => withFlag(true, async () => {
  const exp = await ext.expectedOf({
    meetingTitle: 'Parity', language: 'ja', duration: 30, speakerNames: {},
    segments: messy.map((m) => ({ text: m.text, timestamp: m.ts, isFinal: true, speaker: m.speaker })),
  }, T0 + 60_000);
  const r = live.finalizeSession(U, 'par-1', { captions: exp.payload.captions, meetingTitle: 'Parity', startedAt: exp.payload.startedAt, language: 'ja' });
  assert.equal(r.captionCount, exp.lines);
  assert.equal(r.captionHash, exp.captionHash);
  const st = live.liveSessionStatus(U, 'par-1');
  assert.equal(st.lines, exp.lines);
  assert.equal(st.captionHash, exp.captionHash);
  assert.equal(st.language, 'ja');
  assert.equal(st.startedAt, exp.payload.startedAt);
  assert.ok(ext.serverHoldsExpected({ ok: true, ...st }, exp));
}));

test('flag on: complete-transcript finalize replaces the streamed buffer, keeps repeats, survives a restart', () => withFlag(true, () => {
  // streamed (shorter, with an in-place edit that became a second line)
  live.appendCaptions(U, 'full-1', [{ speaker: 'Ana', text: 'draft', ts: T0 }], 'Streamed');
  const finalList = [
    { speaker: 'Ana', text: 'draft edited', ts: T0 },
    { speaker: 'Ana', text: 'draft edited', ts: T0 + 1000 },
    { speaker: 'Ben', text: 'tail', ts: T0 + 2000 },
  ];
  const r = live.finalizeSession(U, 'full-1', { captions: finalList, startedAt: T0 - 5000, language: 'en-US', durationSec: 120 });
  assert.equal(r.captionCount, 3, 'repeated lines are kept');
  const st = live.liveSessionStatus(U, 'full-1');
  assert.equal(st.state, 'finalized');
  assert.equal(st.lines, 3);
  assert.equal(st.startedAt, T0 - 5000);
  assert.equal(st.language, 'en-US');
  const row = acks.getCrashRow(U, 'full-1');
  assert.equal(row.lines, 3);
  assert.equal(row.language, 'en-US');
  assert.equal(row.duration_sec, 120);
  assert.equal(row.caption_hash, st.captionHash, 'the durable row carries the hash, so a restart still verifies');
  // restart: memory gone, row answers
  live._resetForTests();
  const after = live.liveSessionStatus(U, 'full-1');
  assert.equal(after.state, 'finalized');
  assert.equal(after.lines, 3);
  assert.equal(after.captionHash, st.captionHash);
  assert.equal(after.startedAt, T0 - 5000);
  // the Mac acks; status keeps answering what was acked
  const ok = ackFor('full-1');
  assert.equal(ok.state, 'acked');
  const acked = live.liveSessionStatus(U, 'full-1');
  assert.equal(acked.state, 'acked');
  assert.equal(acked.lines, 3);
  assert.equal(acked.captionHash, st.captionHash);
  assert.equal(acked.language, 'en-US');
  assert.equal(acked.startedAt, T0 - 5000);
}));

test('the streamed mirror view is untouched by an authoritative finalize', () => withFlag(true, () => {
  live.appendCaptions(U, 'mir-1', [{ speaker: 'Ana', text: 'one', ts: T0 }], 'M');
  const before = live.getCaptionsSince(U, 'mir-1', 0);
  live.finalizeSession(U, 'mir-1', { captions: [{ speaker: 'Ana', text: 'one', ts: T0 }, { speaker: 'Ana', text: 'two', ts: T0 + 1 }] });
  const after = live.getCaptionsSince(U, 'mir-1', 0);
  assert.equal(after.captions.length, before.captions.length, 'no replayed captions reach a mirror');
  assert.equal(live.listUnackedLiveSessions(U).find((s) => s.sessionId === 'mir-1').lines, 2);
}));

test('a capture that never streamed (legacy import) is created by the finalize', () => withFlag(true, () => {
  const r = live.finalizeSession(U, 'leg-1', { captions: [{ speaker: 'A', text: 'x', ts: T0 }], meetingTitle: 'Old meeting', startedAt: T0 });
  assert.equal(r.ackRequired, true);
  assert.equal(live.listUnackedLiveSessions(U).find((s) => s.sessionId === 'leg-1').meetingTitle, 'Old meeting');
}));

test('over 2000 lines is 413 CAPTURE_TOO_LARGE and changes nothing', () => withFlag(true, () => {
  live.appendCaptions(U, 'big-1', [{ speaker: 'A', text: 'streamed', ts: T0 }], 'Big');
  const many = Array.from({ length: 2001 }, (_, i) => ({ speaker: 'A', text: `line ${i}`, ts: T0 + i }));
  assert.throws(() => live.finalizeSession(U, 'big-1', { captions: many }), (e) => e.code === 'CAPTURE_TOO_LARGE' && e.status === 413);
  assert.equal(live.liveSessionStatus(U, 'big-1').state, 'live');
}));

test('metadata validation: implausible startedAt/language/durationSec are rejected, never silently ignored', () => {
  const bad = [
    { startedAt: 5 },
    { startedAt: Date.now() + 3 * 86_400_000 },
    { startedAt: 'yesterday' },
    { language: 'not a tag!' },
    { durationSec: -1 },
    { durationSec: 9e9 },
  ];
  for (const b of bad) assert.throws(() => live.validateCaptureMeta(b), (e) => e.code === 'VALIDATION_FAILED', JSON.stringify(b));
  assert.deepEqual(live.validateCaptureMeta({ startedAt: T0, language: 'ja', durationSec: 12.4 }), { startedAt: T0, language: 'ja', durationSec: 12 });
  assert.deepEqual(live.validateCaptureMeta({}), {});
});

test('append: optional startedAt/language/durationSec are stored; without startedAt the earliest caption ts is the start (old clients work)', () => withFlag(true, () => {
  live.appendCaptions(U, 'meta-1', [{ speaker: 'A', text: 'x', ts: T0 + 5000 }, { speaker: 'B', text: 'y', ts: T0 }], 'M', {});
  const list = live.listActiveSessions(U).find((s) => s.sessionId === 'meta-1');
  assert.equal(list.startedAt, T0);
  live.appendCaptions(U, 'meta-2', [{ speaker: 'A', text: 'x', ts: T0 }], 'M', { startedAt: T0 - 9000, language: 'ja', durationSec: 600 });
  const r = live.finalizeSession(U, 'meta-2');
  assert.equal(r.ackRequired, true);
  const row = acks.getCrashRow(U, 'meta-2');
  assert.equal(row.language, 'ja');
  assert.equal(row.duration_sec, 600);
  assert.equal(Date.parse(row.started_at), T0 - 9000);
  // an old client: plain finalize with no body keeps working
  live.appendCaptions(U, 'meta-3', [{ speaker: 'A', text: 'x', ts: Date.now() }], 'Old client');
  assert.equal(live.finalizeSession(U, 'meta-3').finalized, true);
}));

test('flag off: finalize with a body answers the hash and holds nothing (retained client-side)', () => withFlag(false, () => {
  const r = live.finalizeSession(U, 'off-9', { captions: [{ speaker: 'A', text: 'x', ts: T0 }] });
  assert.equal(r.ackRequired, undefined);
  assert.equal(r.captionCount, 1);
  assert.equal(typeof r.captionHash, 'string');
}));

test('a re-send after an ack supersedes it (new content is a new capture) and a durable row is replaced, not refused', () => withFlag(true, () => {
  live.finalizeSession(U, 'sup-1', { captions: [{ speaker: 'A', text: 'v1', ts: T0 }] });
  ackFor('sup-1');
  assert.equal(live.liveSessionStatus(U, 'sup-1').state, 'acked');
  live.finalizeSession(U, 'sup-1', { captions: [{ speaker: 'A', text: 'v1', ts: T0 }, { speaker: 'A', text: 'v2', ts: T0 + 1 }] });
  const st = live.liveSessionStatus(U, 'sup-1');
  assert.equal(st.state, 'finalized');
  assert.equal(st.lines, 2);
  live._resetForTests(); // restart with an unacked durable row, then re-send
  live.finalizeSession(U, 'sup-1', { captions: [{ speaker: 'A', text: 'v3', ts: T0 }] });
  assert.equal(live.liveSessionStatus(U, 'sup-1').lines, 1);
  assert.equal(acks.getCrashRow(U, 'sup-1').lines, 1);
}));

test('the ack still verifies against the authoritative copy (409 on a mismatch, nothing deleted)', () => withFlag(true, () => {
  live.finalizeSession(U, 'ver-1', { captions: [{ speaker: 'A', text: 'x', ts: T0 }, { speaker: 'A', text: 'y', ts: T0 + 1 }] });
  const c = live.listUnackedLiveSessions(U).find((s) => s.sessionId === 'ver-1');
  assert.throws(() => live.ackLiveSession(U, 'ver-1', { noteKey: KEY, hash: c.hash, lines: 1 }), (e) => e.code === 'ACK_MISMATCH');
  assert.equal(live.liveSessionStatus(U, 'ver-1').state, 'finalized');
}));

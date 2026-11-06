// GET /kb/live/:id/capture: the held copy of a finalized, unacked extension capture, read by the desktop
// archivist (desktop/src-tauri/src/capture_archivist.rs). Flag on, temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LIVE_ACK = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_live-capture-archivist-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const live = await import('../agents/live-sessions.mjs');
const acks = await import('../kb/live-acks.mjs');
const { handleLiveRoutes } = await import('../routes/live.mjs');
const conn = db.getDb();

const U = users.registerUser(conn, { email: `cap-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'a' }).id;
const V = users.registerUser(conn, { email: `capv-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'b' }).id;
const T0 = Date.now() - 120_000;
const captions = [
  { speaker: 'Ana', text: 'Let us start the budget review.', ts: T0 },
  { speaker: 'Ben', text: 'Agreed: the rollback plan is ready.', ts: T0 + 60_000 },
];
const hms = (ms) => new Date(ms).toISOString().slice(11, 19);
function finalized(id, meta = {}) {
  live.appendCaptions(U, id, captions, 'Standup');
  live.finalizeSession(U, id, meta);
}
async function get(userId, url) {
  const res = { headersSent: false, status: 0, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } };
  const handled = await handleLiveRoutes({ method: 'GET' }, res, { userId, url });
  return { handled, status: res.status, body: res.body };
}

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('rowsOfTranscript reads "[HH:MM:SS] Speaker: text" lines and drops any other line', () => {
  assert.deepEqual(live.rowsOfTranscript('[09:30:01] Ana: Hello.\n[09:30:02] Ben: Ratio: 3:1\nnot a line\n'), [
    { time: '09:30:01', speaker: 'Ana', text: 'Hello.' },
    { time: '09:30:02', speaker: 'Ben', text: 'Ratio: 3:1' },
  ]);
  assert.deepEqual(live.rowsOfTranscript(''), []);
});

test('a finalized capture in memory: its rows, plus the lines and hash the ack must echo', () => {
  finalized('cap-mem', { language: 'ja' });
  const cap = live.liveCaptureOf(U, 'cap-mem');
  const un = live.listUnackedLiveSessions(U).find((s) => s.sessionId === 'cap-mem');
  assert.equal(cap.lines, un.lines);
  assert.equal(cap.hash, un.hash);
  assert.deepEqual(cap.rows, [
    { time: hms(T0), speaker: 'Ana', text: 'Let us start the budget review.' },
    { time: hms(T0 + 60_000), speaker: 'Ben', text: 'Agreed: the rollback plan is ready.' },
  ]);
  assert.equal(cap.title, 'Standup');
  assert.equal(cap.language, 'ja');
  assert.equal(cap.startedAt, T0);
  assert.equal(cap.durationSec, 60);
});

test('after a restart the capture is read from its durable row', () => {
  finalized('cap-db');
  live._resetForTests();
  const cap = live.liveCaptureOf(U, 'cap-db');
  assert.equal(cap.hash, acks.getCrashRow(U, 'cap-db').content_hash);
  assert.equal(cap.lines, 2);
  assert.equal(cap.rows.length, 2);
  assert.equal(cap.startedAt, T0);
});

test("a live, acked, unknown or other user's capture is not served", () => {
  live.appendCaptions(U, 'cap-live', captions, 'Live');
  assert.equal(live.liveCaptureOf(U, 'cap-live'), null);
  finalized('cap-acked');
  const cap = live.liveCaptureOf(U, 'cap-acked');
  live.ackLiveSession(U, 'cap-acked', { noteKey: 'source/meetings/2026/11/x.md', hash: cap.hash, lines: cap.lines });
  assert.equal(live.liveCaptureOf(U, 'cap-acked'), null);
  assert.equal(live.liveCaptureOf(U, 'nope'), null);
  assert.equal(live.liveCaptureOf(V, 'cap-db'), null);
});

test('GET /kb/live/:id/capture answers 200 with the held copy and 404 otherwise', async () => {
  finalized('cap-http');
  const ok = await get(U, '/kb/live/cap-http/capture');
  assert.equal(ok.handled, true);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sessionId, 'cap-http');
  assert.equal(ok.body.rows.length, 2);
  const missing = await get(V, '/kb/live/cap-http/capture');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

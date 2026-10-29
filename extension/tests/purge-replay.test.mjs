// Purge ordering and the tombstone replay (live-then-archive plan 3.5, review item
// 8): transcripts are deleted before the rows, the SDK ids are captured in the
// tombstone before anything is removed, the reuse guard protects every delete
// path, failures back off and end in a terminal 'failed', and the replay is
// callable and tested with an injected file-delete. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_purge-replay-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const lc = await import('../kb/chat-lifecycle.mjs');
const agentSessions = await import('../kb/agent-sessions.mjs');
const memory = await import('../kb/session-memory.mjs');
const chats = await import('../kb/chat-sessions.mjs');
const { purgeChat, replaySessionPurges } = await import('../routes/lifecycle-routes.mjs');
const { startKbServer } = await import('./helpers/kb-http.mjs');
const conn = db.getDb();

const U = users.registerUser(conn, { email: `pr-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'p' }).id;
const SDK = '11111111-2222-3333-4444-555555555555';
const srv = await startKbServer();
srv.as(U);

test.after(async () => {
  await srv.close();
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

function mapped(chat, sdk = SDK) {
  agentSessions.getOrCreateAgentSession(conn, U, chat, 'explorer');
  agentSessions.markAgentSessionUsed(conn, U, chat, { sdkSessionId: sdk });
}
const mappingExists = (chat) => !!conn.prepare('SELECT 1 FROM agent_sessions WHERE user_id = ? AND mac_chat_session_id = ?').get(U, chat);
const factCount = (chat) => conn.prepare('SELECT COUNT(*) AS n FROM session_memory WHERE user_id = ? AND session_id = ?').get(U, chat).n;
const tombstone = (chat) => conn.prepare('SELECT * FROM pending_session_purges WHERE owner_user_id = ? AND deleted_chat_id = ?').get(U, chat);
const ok = () => {};

test('the SDK ids are captured in the tombstone before anything is removed', () => {
  const chat = 'pr-capture-1';
  mapped(chat);
  lc.enqueueSessionPurge(U, chat, 'user_delete');
  // Simulate a crash right after the rows were removed but before the tombstone completed.
  lc.purgeWorkingState(U, [chat]);
  assert.equal(mappingExists(chat), false);
  const t = tombstone(chat);
  assert.deepEqual(JSON.parse(t.sdk_session_ids), [SDK], 'the replay still knows which transcripts to delete');
  lc.completeSessionPurge(U, chat);
});

test('ordering: transcripts are deleted while the mapping still exists (files first, then rows)', () => {
  const chat = 'pr-order-1';
  mapped(chat);
  let mappingWhenFileDeleted = null;
  purgeChat(U, chat, {
    deleteTranscripts: () => { mappingWhenFileDeleted = mappingExists(chat); },
  });
  assert.equal(mappingWhenFileDeleted, true, 'the file step ran first');
  assert.equal(mappingExists(chat), false, 'then the rows went');
});

test('purge-then-failure: a failing file step keeps the rows and the tombstone; a later replay finishes the job', () => {
  const chat = 'pr-fail-1';
  mapped(chat);
  lc.enqueueSessionPurge(U, chat, 'user_delete');
  const t0 = Date.now();
  const r1 = replaySessionPurges(U, {
    now: t0,
    deleteTranscripts: () => { throw new Error('disk gone'); },
  });
  assert.equal(r1.pending, 1, 'the failed attempt is pending, with backoff');
  assert.equal(mappingExists(chat), true, 'the file step failed before the rows were touched');
  const t = tombstone(chat);
  assert.equal(t.attempts, 1);
  assert.equal(t.state, 'pending');
  assert.ok(Date.parse(t.next_attempt_at) > t0, 'the next attempt is in the future');

  const seen = [];
  const r2 = replaySessionPurges(U, {
    now: Date.parse(t.next_attempt_at) + 1000,
    deleteTranscripts: (u, sdk) => seen.push(sdk),
  });
  assert.equal(r2.done, 1);
  assert.deepEqual(seen, [SDK], 'the replay deleted the captured transcript');
  assert.equal(mappingExists(chat), false);
  assert.equal(tombstone(chat), undefined);
});

test('a tombstone is not retried before its backoff passes', () => {
  const chat = 'pr-notdue-1';
  mapped(chat);
  lc.enqueueSessionPurge(U, chat, 'user_delete');
  replaySessionPurges(U, { now: Date.now(), deleteTranscripts: () => { throw new Error('x'); } });
  const r = replaySessionPurges(U, { now: Date.now(), deleteTranscripts: ok });
  assert.equal(r.notDue, 1);
  assert.equal(mappingExists(chat), true);
  lc.completeSessionPurge(U, chat);
});

test('repeated failures end in a terminal failed state that is surfaced and not retried', () => {
  const chat = 'pr-giveup-1';
  mapped(chat);
  lc.enqueueSessionPurge(U, chat, 'user_delete');
  let last = null;
  for (let i = 0; i < lc.PURGE_MAX_ATTEMPTS; i++) {
    last = lc.failSessionPurge(U, chat, { now: Date.now() + i * 3_600_000 });
  }
  assert.equal(last.state, 'failed');
  const status = lc.sessionPurgeStatus(U);
  assert.ok(status.failed.some((f) => f.chatSessionId === chat && f.attempts === lc.PURGE_MAX_ATTEMPTS));
  const r = replaySessionPurges(U, { now: Date.now() + 365 * 24 * 3_600_000, deleteTranscripts: ok });
  assert.ok(r.failed >= 1, 'a failed tombstone is counted, not retried');
  assert.equal(mappingExists(chat), true, 'and nothing was deleted without a person resolving it');
  lc.completeSessionPurge(U, chat);
});

test('reused id with memory only: a fact written after the delete was requested keeps the chat and its memory', () => {
  const chat = 'pr-memreuse-1';
  memory.appendSessionMemory(U, chat, ['old fact']);
  lc.enqueueSessionPurge(U, chat, 'user_delete');
  // A fact is written after the request: the chat is live again.
  conn.prepare('UPDATE session_memory SET created_at = ? WHERE user_id = ? AND session_id = ?')
    .run(Date.now() / 1000 + 60, U, chat);
  const seen = [];
  const r = replaySessionPurges(U, { now: Date.now() + 1000, deleteTranscripts: (u, sdk) => seen.push(sdk) });
  assert.equal(r.skippedReused, 1);
  assert.equal(factCount(chat), 1, 'the memory survives');
  assert.deepEqual(seen, [], 'and no transcript was deleted on the reuse path either');
  assert.equal(tombstone(chat), undefined, 'the tombstone is dropped');
});

test('reused id via the chat row: a chat updated after the request is not purged on any path', () => {
  const chat = chats.createChatSession(U, { title: 'reuse', surface: 'extension', mode: 'transcript' }).id;
  lc.enqueueSessionPurge(U, chat, 'user_delete');
  conn.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(Date.now() / 1000 + 120, chat);
  const r = replaySessionPurges(U, { now: Date.now() + 1000, deleteTranscripts: ok });
  assert.equal(r.skippedReused, 1);
  assert.ok(conn.prepare('SELECT 1 FROM chat_sessions WHERE id = ?').get(chat), 'the chat row survives');
});

test('HTTP: POST /kb/session-purges answers 202 done and the tombstone is gone; working-state shows no failed purges', async () => {
  const chat = 'pr-http-1';
  mapped(chat);
  const r = await srv.call('POST', '/kb/session-purges', { chatSessionId: chat, reason: 'user_delete' });
  assert.equal(r.status, 202);
  assert.equal(r.body.purged, 'done');
  assert.equal(mappingExists(chat), false);
  const ws = await srv.call('GET', '/kb/agent/working-state');
  assert.equal(ws.status, 200);
  assert.deepEqual(ws.body.purges.failed, []);
});

test('HTTP: an invalid tombstone reason is 400 and writes nothing', async () => {
  const r = await srv.call('POST', '/kb/session-purges', { chatSessionId: 'pr-bad', reason: 'because' });
  assert.equal(r.status, 400);
  assert.equal(tombstone('pr-bad'), undefined);
});

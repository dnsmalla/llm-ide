// U#F5: DELETE /kb/chat/sessions/:id/messages/:seq drops exactly the interrupted assistant partial a
// retried turn replaces. These are the route's guarantees: JWT required, the session's own ownership, only
// an interrupted assistant row, exact seq (older partials stay), and idempotency. Temp DB, in-process HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_chat-message-drop-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const chats = await import('../kb/chat-sessions.mjs');
const { startKbServer } = await import('./helpers/kb-http.mjs');
const conn = db.getDb();

const U = users.registerUser(conn, { email: `drop-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'drop' }).id;
const V = users.registerUser(conn, { email: `dropv-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'other' }).id;
const srv = await startKbServer();
srv.as(U);

test.after(async () => {
  await srv.close();
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

const INTERRUPTED = { interrupted: true, status: 'interrupted' };
const seqs = (id) => conn.prepare('SELECT seq FROM chat_messages WHERE session_id = ? ORDER BY seq').all(id).map((r) => r.seq);
const contentAt = (id, seq) => conn.prepare('SELECT content FROM chat_messages WHERE session_id = ? AND seq = ?').get(id, seq)?.content;

/** q1, old partial (interrupted), q2, half reply (interrupted), q3: dropping the newest partial must leave q1-first history and the older partial alone. */
function seeded(userId = U) {
  const s = chats.createChatSession(userId, { title: 'retry', surface: 'extension', mode: 'transcript' });
  chats.appendChatMessage(userId, s.id, { role: 'user', content: 'q1' });
  chats.appendChatMessage(userId, s.id, { role: 'assistant', content: 'old partial', meta: INTERRUPTED });
  chats.appendChatMessage(userId, s.id, { role: 'user', content: 'q2' });
  chats.appendChatMessage(userId, s.id, { role: 'assistant', content: 'half reply', meta: INTERRUPTED });
  chats.appendChatMessage(userId, s.id, { role: 'user', content: 'q3' });
  return s.id;
}

test('drops exactly the named interrupted partial; prior history and another interrupted partial stay', async () => {
  const id = seeded();
  const before = conn.prepare('SELECT updated_at FROM chat_sessions WHERE id = ?').get(id).updated_at;
  const res = await srv.call('DELETE', `/kb/chat/sessions/${id}/messages/4`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { deleted: true, seq: 4, status: 'deleted' });
  assert.deepEqual(seqs(id), [1, 2, 3, 5], 'only seq 4 is gone');
  assert.equal(contentAt(id, 2), 'old partial', 'the older interrupted partial is history and is not touched');
  assert.equal(conn.prepare('SELECT updated_at FROM chat_sessions WHERE id = ?').get(id).updated_at, before, 'a repair does not reorder the chat list');
});

test('idempotent: repeating the delete answers deleted:false and changes nothing', async () => {
  const id = seeded();
  assert.equal((await srv.call('DELETE', `/kb/chat/sessions/${id}/messages/4`)).body.deleted, true);
  const again = await srv.call('DELETE', `/kb/chat/sessions/${id}/messages/4`);
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.body, { deleted: false, seq: 4, status: 'already_gone' });
  assert.deepEqual(seqs(id), [1, 2, 3, 5]);
});

test('only an interrupted assistant row can be dropped (a user row or a completed reply is 409)', async () => {
  const id = seeded();
  const s = chats.createChatSession(U, { title: 'done', surface: 'extension', mode: 'transcript' });
  chats.appendChatMessage(U, s.id, { role: 'assistant', content: 'complete', meta: { status: 'done' } });

  const userRow = await srv.call('DELETE', `/kb/chat/sessions/${id}/messages/1`);
  assert.equal(userRow.status, 409, userRow.text);
  assert.equal(userRow.body.error.code, 'MESSAGE_NOT_INTERRUPTED');
  const done = await srv.call('DELETE', `/kb/chat/sessions/${s.id}/messages/1`);
  assert.equal(done.status, 409, done.text);
  assert.equal(contentAt(id, 1), 'q1');
  assert.equal(contentAt(s.id, 1), 'complete');
});

test('ownership: another user cannot drop a message from this chat (404, nothing changed)', async () => {
  const id = seeded();
  srv.as(V);
  const res = await srv.call('DELETE', `/kb/chat/sessions/${id}/messages/4`);
  assert.equal(res.status, 404, res.text);
  srv.as(U);
  assert.deepEqual(seqs(id), [1, 2, 3, 4, 5], 'the chat is invisible to the other user');
  assert.equal(contentAt(id, 4), 'half reply');
});

test('a missing session is 404; no JWT is 401; a bad seq is 400', async () => {
  const unknown = await srv.call('DELETE', '/kb/chat/sessions/00000000-0000-4000-8000-000000000000/messages/1');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'NOT_FOUND');

  const id = seeded();
  srv.as(null);
  const noAuth = await srv.call('DELETE', `/kb/chat/sessions/${id}/messages/4`);
  assert.equal(noAuth.status, 401, noAuth.text);
  assert.equal(noAuth.body.error.code, 'AUTH_REQUIRED');
  srv.as(U);

  const zero = await srv.call('DELETE', `/kb/chat/sessions/${id}/messages/0`);
  assert.equal(zero.status, 400, zero.text);
  assert.equal(zero.body.error.code, 'VALIDATION_FAILED');
});

test('the store helper refuses a non-integer seq (the route validates first)', () => {
  const id = seeded();
  for (const bad of [0, -1, 1.5, NaN, '4', null]) assert.throws(() => chats.deleteChatMessage(U, id, bad), /seq must be an integer/);
  assert.deepEqual(seqs(id), [1, 2, 3, 4, 5]);
});

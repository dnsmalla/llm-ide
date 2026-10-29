// The archive protocol at scale and over HTTP (live-then-archive plan 3.3, Phase 1
// review fixes): long chats are archived incomplete unless the client accepts it,
// the archive is paged under one fence, the commit proves the Mac's own hash and
// answers 404 unless a receipt says the chat was archived, and purging working
// state requires a receipt. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_chat-archive-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const chats = await import('../kb/chat-sessions.mjs');
const lc = await import('../kb/chat-lifecycle.mjs');
const agentSessions = await import('../kb/agent-sessions.mjs');
const { startKbServer } = await import('./helpers/kb-http.mjs');
const conn = db.getDb();

const U = users.registerUser(conn, { email: `arch-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'a' }).id;
const V = users.registerUser(conn, { email: `archv-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'b' }).id;
const srv = await startKbServer();
srv.as(U);

test.after(async () => {
  await srv.close();
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

function chatWith(n, userId = U, prefix = 'm') {
  const s = chats.createChatSession(userId, { title: 'long', surface: 'extension', mode: 'transcript' });
  // Direct inserts keep 2000+ messages cheap; the cap logic is exercised by the
  // real append path in the dedicated test below.
  const ins = conn.prepare('INSERT INTO chat_messages (session_id, user_id, seq, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)');
  conn.transaction(() => {
    for (let i = 1; i <= n; i++) ins.run(s.id, userId, i, i % 2 ? 'user' : 'assistant', `${prefix} message ${i}`, 1798500000 + i);
  })();
  conn.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(1798500000 + n, s.id);
  return s.id;
}
const rows = (id) => conn.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?').get(id).n;

test('a chat over 2000 messages is pruned by the live store and counted; its archive is incomplete', () => {
  const s = chats.createChatSession(U, { title: 'overflow', surface: 'extension', mode: 'transcript' });
  for (let i = 0; i < 2005; i++) chats.appendChatMessage(U, s.id, { role: 'user', content: `msg ${i}` });
  assert.equal(rows(s.id), 2000);
  const row = conn.prepare('SELECT pruned_messages FROM chat_sessions WHERE id = ?').get(s.id);
  assert.equal(row.pruned_messages, 5, 'the five pruned messages are counted');
  const snap = lc.archiveBegin(U, s.id);
  assert.equal(snap.incomplete.incomplete, true);
  assert.equal(snap.incomplete.prunedMessages, 5);
  assert.equal(lc.archiveCommit(U, s.id, { fence: snap.fence, hash: snap.hash }).status, 'incomplete', 'refused without consent');
  assert.equal(rows(s.id), 2000, 'nothing was deleted');
  const ok = lc.archiveCommit(U, s.id, { fence: snap.fence, hash: snap.hash, acceptIncomplete: true });
  assert.equal(ok.status, 'deleted');
  assert.equal(ok.count, 2000);
});

test('a message over the 64 KB content cap is truncated and counted, so the archive is incomplete', () => {
  const s = chats.createChatSession(U, { title: 'big', surface: 'extension', mode: 'transcript' });
  chats.appendChatMessage(U, s.id, { role: 'user', content: 'x'.repeat(70 * 1024) });
  const row = conn.prepare('SELECT truncated_messages FROM chat_sessions WHERE id = ?').get(s.id);
  assert.equal(row.truncated_messages, 1);
  assert.equal(lc.archiveBegin(U, s.id).incomplete.incomplete, true);
});

test('the streaming digest equals the array digest over the same messages', () => {
  const id = chatWith(7);
  const snap = lc.archiveBegin(U, id, { limit: 3 });
  const all = conn.prepare('SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY seq').all(id);
  assert.equal(snap.hash, lc.archiveHash(all));
  assert.equal(snap.count, 7);
});

test('paging: pages are bounded, their concatenation is the whole chat, and the hash covers every message', () => {
  const id = chatWith(450, U, 'page');
  const first = lc.archiveBegin(U, id, { limit: 200 });
  assert.equal(first.messages.length, 200);
  assert.equal(first.nextAfter, 200);
  const second = lc.archiveBegin(U, id, { after: first.nextAfter, limit: 200, fence: first.fence });
  assert.equal(second.messages.length, 200);
  assert.equal(second.fence, first.fence, 'a continuation page does not bump the fence');
  assert.equal(second.hash, first.hash, 'the digest is over the whole chat, on every page');
  const third = lc.archiveBegin(U, id, { after: second.nextAfter, limit: 200, fence: first.fence });
  assert.equal(third.messages.length, 50);
  assert.equal(third.nextAfter, null);
  const seen = [...first.messages, ...second.messages, ...third.messages].map((m) => m.seq);
  assert.deepEqual(seen, Array.from({ length: 450 }, (_, i) => i + 1));
});

test('a continuation page with a stale fence is ARCHIVE_STALE', () => {
  const id = chatWith(10, U, 'fence');
  const first = lc.archiveBegin(U, id, { limit: 5 });
  lc.archiveBegin(U, id); // a new begin supersedes the fence
  assert.deepEqual(lc.archiveBegin(U, id, { after: first.nextAfter, limit: 5, fence: first.fence }), { stale: true });
});

test('a Mac hash that differs from the rows is refused with stale, and nothing is deleted', () => {
  const id = chatWith(4, U, 'mac');
  const snap = lc.archiveBegin(U, id);
  const mineWrong = lc.archiveHash([{ role: 'user', content: 'a different file' }]);
  assert.equal(lc.archiveCommit(U, id, { fence: snap.fence, hash: mineWrong }).status, 'stale');
  assert.equal(rows(id), 4);
});

test('commit for a missing row: 404 without a matching receipt, already_archived with one', () => {
  const id = chatWith(2, U, 'rc');
  const snap = lc.archiveBegin(U, id);
  assert.equal(lc.archiveCommit(U, id, { fence: snap.fence, hash: snap.hash }).status, 'deleted');
  assert.equal(lc.archiveCommit(U, id, { fence: snap.fence, hash: snap.hash }).status, 'already_archived', 'the commit receipt answers');
  assert.equal(lc.archiveCommit(U, id, { fence: snap.fence, hash: '0'.repeat(64) }).status, 'not_found', 'a different hash is not an archive of this chat');
  assert.equal(lc.archiveCommit(U, 'never-existed', { fence: 1, hash: 'a'.repeat(64) }).status, 'not_found', 'no receipt: 404');
});

test('purging working state requires a receipt: no receipt is 409 NO_RECEIPT and nothing is purged', async () => {
  const chat = 'mac-chat-receipt-1';
  agentSessions.getOrCreateAgentSession(conn, U, chat, 'explorer');
  const r = await srv.call('POST', '/agent/v2/sessions/purge', { chatSessionIds: [chat], verified: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'NO_RECEIPT');
  assert.deepEqual(r.body.error.details.missing, [chat]);
  assert.ok(conn.prepare("SELECT 1 FROM agent_sessions WHERE user_id = ? AND mac_chat_session_id = ?").get(U, chat), 'the mapping is still there');
});

test('a bare verified:true is not enough: the Mac records its own receipt, then the purge runs', async () => {
  const chat = 'mac-chat-receipt-2';
  agentSessions.getOrCreateAgentSession(conn, U, chat, 'explorer');
  const hash = lc.archiveHash([{ role: 'user', content: 'what I wrote' }]);
  const rec = await srv.call('POST', '/kb/archive-receipts', { chatSessionId: chat, hash, count: 1 });
  assert.equal(rec.status, 200);
  const r = await srv.call('POST', '/agent/v2/sessions/purge', { chatSessionIds: [chat], verified: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.purged, 1);
});

test('the receipt route refuses a malformed hash and a negative count', async () => {
  const bad = await srv.call('POST', '/kb/archive-receipts', { chatSessionId: 'c', hash: 'not-hex', count: 1 });
  assert.equal(bad.status, 400);
  const neg = await srv.call('POST', '/kb/archive-receipts', { chatSessionId: 'c', hash: 'a'.repeat(64), count: -1 });
  assert.equal(neg.status, 400);
});

test('HTTP: begin, page, commit (wrong hash 409, right hash 200), then the chat is gone and the commit is idempotent', async () => {
  const id = chatWith(3, U, 'http');
  const begin = await srv.call('POST', `/kb/chat/sessions/${id}/archive/begin`);
  assert.equal(begin.status, 200);
  assert.equal(begin.body.count, 3);
  assert.equal(begin.body.messages.length, 3);
  const wrong = await srv.call('POST', `/kb/chat/sessions/${id}/archive/commit`, { fence: begin.body.fence, hash: '1'.repeat(64) });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error.code, 'ARCHIVE_STALE');
  assert.equal(rows(id), 3, 'the wrong hash deleted nothing');
  const right = await srv.call('POST', `/kb/chat/sessions/${id}/archive/commit`, { fence: begin.body.fence, hash: begin.body.hash });
  assert.equal(right.status, 200);
  assert.equal(right.body.status, 'deleted');
  const again = await srv.call('POST', `/kb/chat/sessions/${id}/archive/commit`, { fence: begin.body.fence, hash: begin.body.hash });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'already_archived');
  const unknown = await srv.call('POST', `/kb/chat/sessions/no-such-chat/archive/commit`, { fence: 1, hash: 'a'.repeat(64) });
  assert.equal(unknown.status, 404);
});

test('HTTP: an incomplete chat answers 409 INCOMPLETE_ARCHIVE until acceptIncomplete is sent', async () => {
  const s = chats.createChatSession(U, { title: 'http-over', surface: 'extension', mode: 'transcript' });
  for (let i = 0; i < 2002; i++) chats.appendChatMessage(U, s.id, { role: 'user', content: `o ${i}` });
  const begin = await srv.call('POST', `/kb/chat/sessions/${s.id}/archive/begin`);
  assert.equal(begin.body.incomplete.incomplete, true);
  const refused = await srv.call('POST', `/kb/chat/sessions/${s.id}/archive/commit`, { fence: begin.body.fence, hash: begin.body.hash });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'INCOMPLETE_ARCHIVE');
  assert.equal(refused.body.error.details.prunedMessages, 2);
  const accepted = await srv.call('POST', `/kb/chat/sessions/${s.id}/archive/commit`, { fence: begin.body.fence, hash: begin.body.hash, acceptIncomplete: true });
  assert.equal(accepted.status, 200);
});

test('HTTP: a paged begin with a bad fence is 409, and a bad after is 400', async () => {
  const id = chatWith(30, U, 'pg-http');
  const first = await srv.call('POST', `/kb/chat/sessions/${id}/archive/begin?limit=10`);
  assert.equal(first.body.messages.length, 10);
  const next = await srv.call('POST', `/kb/chat/sessions/${id}/archive/begin?after=${first.body.nextAfter}&fence=${first.body.fence + 5}`);
  assert.equal(next.status, 409);
  assert.equal(next.body.error.code, 'ARCHIVE_STALE');
  const bad = await srv.call('POST', `/kb/chat/sessions/${id}/archive/begin?after=abc&fence=1`);
  assert.equal(bad.status, 400);
});

test('another user cannot begin or commit this user\'s chat', async () => {
  const id = chatWith(2, U, 'iso');
  srv.as(V);
  const b = await srv.call('POST', `/kb/chat/sessions/${id}/archive/begin`);
  assert.equal(b.status, 404);
  srv.as(U);
  assert.equal(rows(id), 2);
});

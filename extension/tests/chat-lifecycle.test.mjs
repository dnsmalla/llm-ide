// Chat lifecycle on the server (live-then-archive T1.3): the crash rows of plan
// 3.4 that the server can see (C5 crash after begin, C6 hash mismatch and a
// racing append, stale fence, double commit), working state, purge, and the
// delete-everywhere tombstones. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_chat-lifecycle-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const chats = await import('../kb/chat-sessions.mjs');
const lc = await import('../kb/chat-lifecycle.mjs');
const agentSessions = await import('../kb/agent-sessions.mjs');
const memory = await import('../kb/session-memory.mjs');
const { replaySessionPurges } = await import('../routes/lifecycle-routes.mjs');
const conn = db.getDb();

const U = users.registerUser(conn, { email: `lc-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'lc' }).id;
const V = users.registerUser(conn, { email: `lcv-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'lcv' }).id;

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

function extensionChat(userId, messages) {
  const s = chats.createChatSession(userId, { title: 'ext chat', surface: 'extension', mode: 'transcript' });
  for (const m of messages) chats.appendChatMessage(userId, s.id, m);
  return s.id;
}
const rowOf = (id) => conn.prepare('SELECT lifecycle, fence FROM chat_sessions WHERE id = ?').get(id);
const msgCount = (id) => conn.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?').get(id).n;

test('archiveHash is length-prefixed: different message splits never collide', () => {
  const a = lc.archiveHash([{ role: 'user', content: 'ab' }, { role: 'assistant', content: 'c' }]);
  const b = lc.archiveHash([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'bc' }]);
  assert.notEqual(a, b);
  assert.equal(a, lc.archiveHash([{ role: 'user', content: 'ab' }, { role: 'assistant', content: 'c' }]), 'deterministic');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(lc.archiveHash([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty list is sha256 of nothing');
});

test('begin on an unknown or another user\'s chat returns null', () => {
  assert.equal(lc.archiveBegin(U, 'no-such-chat'), null);
  const id = extensionChat(U, [{ role: 'user', content: 'mine' }]);
  assert.equal(lc.archiveBegin(V, id), null, 'V cannot begin U\'s archive');
});

test('begin returns the full snapshot, the hash and a fence, and marks the chat archiving', () => {
  const id = extensionChat(U, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
  const snap = lc.archiveBegin(U, id);
  assert.equal(snap.count, 2);
  assert.equal(snap.fence, 1);
  assert.equal(snap.hash, lc.archiveHash(snap.messages));
  assert.equal(snap.messages.map((m) => m.content).join('|'), 'hello|hi');
  assert.equal(rowOf(id).lifecycle, 'archiving');
});

test('C5: a crash after begin (no file written) leaves the rows intact; a new begin supersedes the fence', () => {
  const id = extensionChat(U, [{ role: 'user', content: 'survives a crash' }]);
  const first = lc.archiveBegin(U, id);
  // the Mac dies here: no file, no commit. The next start begins again.
  const second = lc.archiveBegin(U, id);
  assert.equal(second.fence, first.fence + 1);
  assert.equal(second.hash, first.hash, 'the rows are unchanged');
  assert.equal(msgCount(id), 1, 'nothing was deleted');
});

test('C6: a commit whose hash does not match the rows is refused and deletes nothing', () => {
  const id = extensionChat(U, [{ role: 'user', content: 'checked' }]);
  const snap = lc.archiveBegin(U, id);
  const wrong = lc.archiveCommit(U, id, { fence: snap.fence, hash: '0'.repeat(64) });
  assert.equal(wrong.status, 'stale');
  assert.equal(msgCount(id), 1);
  const ok = lc.archiveCommit(U, id, { fence: snap.fence, hash: snap.hash });
  assert.equal(ok.status, 'deleted');
  assert.equal(ok.count, 1);
  assert.equal(msgCount(id), 0);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE id = ?').get(id).n, 0);
});

test('an append that races in after begin changes the hash, so the commit is refused (C6 variant)', () => {
  const id = extensionChat(U, [{ role: 'user', content: 'before begin' }]);
  const snap = lc.archiveBegin(U, id);
  chats.appendChatMessage(U, id, { role: 'user', content: 'raced in' });
  const r = lc.archiveCommit(U, id, { fence: snap.fence, hash: snap.hash });
  assert.equal(r.status, 'stale');
  assert.equal(msgCount(id), 2, 'the late message is kept');
  const again = lc.archiveBegin(U, id);
  assert.equal(again.count, 2);
  assert.equal(lc.archiveCommit(U, id, { fence: again.fence, hash: again.hash }).status, 'deleted');
});

test('a stale fence is refused even when the hash matches', () => {
  const id = extensionChat(U, [{ role: 'user', content: 'fenced' }]);
  const old = lc.archiveBegin(U, id);
  const newer = lc.archiveBegin(U, id);
  assert.equal(lc.archiveCommit(U, id, { fence: old.fence, hash: old.hash }).status, 'stale');
  assert.equal(msgCount(id), 1);
  assert.equal(lc.archiveCommit(U, id, { fence: newer.fence, hash: newer.hash }).status, 'deleted');
});

test('a double commit is idempotent: the second one reports already_archived', () => {
  const id = extensionChat(U, [{ role: 'user', content: 'once' }]);
  const snap = lc.archiveBegin(U, id);
  assert.equal(lc.archiveCommit(U, id, { fence: snap.fence, hash: snap.hash }).status, 'deleted');
  assert.equal(lc.archiveCommit(U, id, { fence: snap.fence, hash: snap.hash }).status, 'already_archived');
});

test('working state lists mapped and remembered chats; purge removes both and is idempotent', () => {
  const chat = 'mac-chat-working-1';
  agentSessions.getOrCreateAgentSession(conn, U, chat, 'explorer');
  agentSessions.markAgentSessionUsed(conn, U, chat, { sdkSessionId: '11111111-2222-3333-4444-555555555555' });
  memory.appendSessionMemory(U, chat, ['the user prefers tabs', 'the deadline is friday']);
  const state = lc.listWorkingState(U).sessions.find((s) => s.chatSessionId === chat);
  assert.equal(state.factCount, 2);
  assert.equal(state.sdkSession, '11111111-2222-3333-4444-555555555555');

  const first = lc.purgeWorkingState(U, [chat]);
  assert.equal(first.purged, 1);
  assert.deepEqual(first.sdkSessionIds, ['11111111-2222-3333-4444-555555555555']);
  assert.equal(lc.listWorkingState(U).sessions.find((s) => s.chatSessionId === chat), undefined);
  assert.deepEqual(lc.purgeWorkingState(U, [chat]), { purged: 0, sdkSessionIds: [] }, 'second purge is a no-op');
});

test('purge input is validated: an array of non-empty strings, at most 500', () => {
  assert.throws(() => lc.purgeWorkingState(U, 'x'), /chatSessionIds/);
  assert.throws(() => lc.purgeWorkingState(U, ['']), /chatSessionIds/);
  assert.throws(() => lc.purgeWorkingState(U, Array.from({ length: 501 }, (_, i) => `c${i}`)), /chatSessionIds/);
});

test('tombstones: the reason is checked, a re-queue refreshes it, and replay purges a dead chat', () => {
  assert.throws(() => lc.enqueueSessionPurge(U, 'c-bad', 'because'), /reason/);
  const chat = 'mac-chat-deleted-1';
  agentSessions.getOrCreateAgentSession(conn, U, chat, 'explorer');
  memory.appendSessionMemory(U, chat, ['gone soon']);
  lc.enqueueSessionPurge(U, chat, 'user_delete');
  assert.equal(lc.listSessionPurges(U).length, 1);
  lc.enqueueSessionPurge(U, chat, 'user_delete');
  assert.equal(lc.listSessionPurges(U).length, 1, 'one tombstone per chat');
  const r = replaySessionPurges(U);
  assert.equal(r.done, 1);
  assert.equal(lc.listSessionPurges(U).length, 0);
  assert.equal(lc.listWorkingState(U).sessions.find((s) => s.chatSessionId === chat), undefined);
});

test('DL16: a chat used after its delete was requested is not purged; its tombstone is dropped', () => {
  const chat = 'mac-chat-reused-1';
  agentSessions.getOrCreateAgentSession(conn, U, chat, 'explorer');
  lc.enqueueSessionPurge(U, chat, 'user_delete');
  // the chat is used again after the tombstone was written
  conn.prepare("UPDATE agent_sessions SET last_used_at = '2999-01-01T00:00:00.000Z' WHERE user_id = ? AND mac_chat_session_id = ?").run(U, chat);
  const r = replaySessionPurges(U);
  assert.equal(r.skippedReused, 1);
  assert.equal(lc.listWorkingState(U).sessions.some((s) => s.chatSessionId === chat), true, 'the live chat keeps its working state');
});

test('the tombstone table is per owner: V\'s replay never touches U\'s tombstones', () => {
  lc.enqueueSessionPurge(U, 'owned-by-u', 'user_delete');
  assert.equal(lc.listSessionPurges(V).some((p) => p.chatSessionId === 'owned-by-u'), false);
  lc.completeSessionPurge(U, 'owned-by-u');
});

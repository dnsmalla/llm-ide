// Purge guards (lta Phase 4 review): a chat with a turn in flight is never purged (the TOCTOU between the
// client's re-check and the HTTP call), a receipt older than the chat's last use is refused, and the DL16
// reuse guard runs on the LIVE path and still works once the mapping is gone. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_purge-guards-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-claude-'));
process.env.CLAUDE_CONFIG_DIR = claudeDir;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const lc = await import('../kb/chat-lifecycle.mjs');
const agentSessions = await import('../kb/agent-sessions.mjs');
const { setBusyCheckForTesting, replaySessionPurges } = await import('../routes/lifecycle-routes.mjs');
const { startKbServer } = await import('./helpers/kb-http.mjs');
const conn = db.getDb();
const U = users.registerUser(conn, { email: `pg-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'p' }).id;
const SDK = '99999999-2222-3333-4444-555555555555';
const srv = await startKbServer();
srv.as(U);

test.after(async () => {
  setBusyCheckForTesting();
  await srv.close();
  db.closeDb();
  fs.rmSync(claudeDir, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

function mapped(chat, usedAt = null) {
  agentSessions.getOrCreateAgentSession(conn, U, chat, 'explorer');
  agentSessions.markAgentSessionUsed(conn, U, chat, { sdkSessionId: SDK });
  if (usedAt) conn.prepare('UPDATE agent_sessions SET last_used_at = ? WHERE user_id = ? AND mac_chat_session_id = ?').run(usedAt, U, chat);
}
const exists = (chat) => !!conn.prepare('SELECT 1 FROM agent_sessions WHERE user_id = ? AND mac_chat_session_id = ?').get(U, chat);
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const receipt = (chat, hash = 'c'.repeat(64)) => lc.recordMacArchiveReceipt(U, chat, { hash, count: 2 });

test('a chat whose turn started after the client re-check is reported busy and keeps everything', async () => {
  const chat = 'pg-busy-1';
  mapped(chat, sqlTime(Date.now() - 3600_000));
  receipt(chat);
  setBusyCheckForTesting((uid, id) => uid === U && id === chat);   // the turn started between re-check and call
  const r = await srv.call('POST', '/agent/v2/sessions/purge', { chatSessionIds: [chat], verified: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { purged: 0, busy: [chat], staleReceipt: [] });
  assert.equal(exists(chat), true);
  setBusyCheckForTesting();
  const again = await srv.call('POST', '/agent/v2/sessions/purge', { chatSessionIds: [chat], verified: true });
  assert.equal(again.body.purged, 1, 'retried later it purges');
});

test('a receipt older than the chat\'s last use is refused as stale_receipt, others in the batch still purge', async () => {
  const stale = 'pg-stale-1';
  const fine = 'pg-fine-1';
  mapped(stale, sqlTime(Date.now() - 3600_000));
  mapped(fine, sqlTime(Date.now() - 3600_000));
  receipt(stale); receipt(fine);
  await new Promise((r) => setTimeout(r, 1100));
  conn.prepare('UPDATE agent_sessions SET last_used_at = ? WHERE user_id = ? AND mac_chat_session_id = ?').run(sqlTime(Date.now()), U, stale);
  const r = await srv.call('POST', '/agent/v2/sessions/purge', { chatSessionIds: [stale, fine], verified: true });
  assert.deepEqual(r.body, { purged: 1, busy: [], staleReceipt: [stale] });
  assert.equal(exists(stale), true);
  assert.equal(exists(fine), false);
});

test('a purge with no receipt is still refused whole (409 NO_RECEIPT)', async () => {
  const r = await srv.call('POST', '/agent/v2/sessions/purge', { chatSessionIds: ['pg-none'], verified: true });
  assert.equal(r.status, 409);
});

test('a delete tombstone for a busy chat stays pending and says busy', async () => {
  const chat = 'pg-busy-del';
  mapped(chat, sqlTime(Date.now() - 3600_000));
  setBusyCheckForTesting((uid, id) => id === chat);
  const r = await srv.call('POST', '/kb/session-purges', { chatSessionId: chat });
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { queued: true, purged: 'pending', busy: true });
  assert.equal(exists(chat), true);
  const replay = replaySessionPurges(U);
  assert.equal(replay.busy, 1, 'replay skips it without counting an attempt');
  assert.equal(lc.listSessionPurges(U).find((p) => p.chatSessionId === chat).attempts, 0);
  setBusyCheckForTesting();
  assert.equal(replaySessionPurges(U).done, 1);
  assert.equal(exists(chat), false);
});

test('DL16 on the live path: a chat used after the delete was requested is kept and the tombstone dropped', async () => {
  const chat = 'pg-reuse-live';
  mapped(chat, sqlTime(Date.now() + 5_000));                       // used after the delete time the Mac sends
  const asked = new Date(Date.now() - 60_000).toISOString();
  const r = await srv.call('POST', '/kb/session-purges', { chatSessionId: chat, requestedAt: asked });
  assert.deepEqual(r.body, { queued: true, purged: 'done', skippedReused: true });
  assert.equal(exists(chat), true, 'the reused chat keeps its mapping');
  assert.equal(lc.listSessionPurges(U).some((p) => p.chatSessionId === chat), false);
});

test('a re-sent tombstone keeps the earliest request time', () => {
  const chat = 'pg-earliest';
  const t0 = new Date(Date.now() - 3600_000).toISOString();
  lc.enqueueSessionPurge(U, chat, 'user_delete', { requestedAt: t0 });
  lc.enqueueSessionPurge(U, chat, 'user_delete');                  // a retry at the next start
  assert.equal(lc.listSessionPurges(U).find((p) => p.chatSessionId === chat).requestedAt, t0);
  lc.completeSessionPurge(U, chat);
});

test('DL16 still works when the mapping is gone: a transcript written after the request keeps the chat', () => {
  const chat = 'pg-reuse-nomap';
  mapped(chat, sqlTime(Date.now() - 3600_000));
  lc.enqueueSessionPurge(U, chat, 'user_delete', { requestedAt: new Date(Date.now() - 600_000).toISOString() });
  lc.purgeWorkingState(U, [chat]);                                  // mapping gone, tombstone holds the SDK id
  const proj = path.join(claudeDir, 'projects', 'ws');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SDK}.jsonl`), '{}');          // written just now, after the request
  const r = replaySessionPurges(U);
  assert.equal(r.skippedReused, 1);
  assert.equal(fs.existsSync(path.join(proj, `${SDK}.jsonl`)), true, 'the newer transcript was not deleted');
});

test('orphan purge removes working state only, refuses a chat that has server rows, skips a busy one', async () => {
  const chats = await import('../kb/chat-sessions.mjs');
  const orphan = 'pg-orphan-1';
  mapped(orphan, sqlTime(Date.now() - 86_400_000 * 9));
  const ext = chats.createChatSession(U, { title: 'ext', surface: 'extension', mode: 'transcript' }).id;
  chats.appendChatMessage(U, ext, { role: 'user', content: 'only copy' });
  mapped(ext, sqlTime(Date.now() - 86_400_000 * 9));
  const busyOne = 'pg-orphan-busy';
  mapped(busyOne);
  setBusyCheckForTesting((uid, id) => id === busyOne);
  const r = await srv.call('POST', '/agent/v2/sessions/purge', { chatSessionIds: [orphan, ext, busyOne], verified: true, orphan: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { purged: 1, busy: [busyOne], staleReceipt: [], refused: [ext] });
  assert.equal(exists(orphan), false);
  assert.equal(exists(ext), true, 'the extension chat keeps its mapping');
  assert.equal(chats.getChatSession(U, ext) !== null, true, 'and its rows (the only copy) are untouched');
  setBusyCheckForTesting();
});

test('chat session list pages with offset so a client can read every chat, any surface', async () => {
  const chats = await import('../kb/chat-sessions.mjs');
  for (let i = 0; i < 5; i += 1) chats.createChatSession(U, { title: `p${i}`, surface: i % 2 ? 'extension' : 'mac', mode: 'transcript' });
  const a = await srv.call('GET', '/kb/chat/sessions?limit=3&offset=0');
  const b = await srv.call('GET', '/kb/chat/sessions?limit=3&offset=3');
  const ids = [...a.body.sessions, ...b.body.sessions].map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'no row appears on two pages');
  assert.ok(a.body.sessions.length === 3 && b.body.sessions.length >= 1);
});

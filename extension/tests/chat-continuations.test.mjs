// The per-chat continuation summary store (plan 2026-11-07-ended-chat-continuation.md, migration 0065).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_chat-continuations-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb, closeDb, deleteUserCascade } = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const store = await import('../kb/chat-continuations.mjs');
const { createChatSession, appendChatMessage, deleteChatSession, clearChatMessages } = await import('../kb/chat-sessions.mjs');
const { purgeWorkingState } = await import('../kb/chat-lifecycle.mjs');

let n = 0;
const mk = () => registerUser(getDb(), { email: `cc-${++n}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c' });
const HASH = 'a'.repeat(64);
const put = (u, chat, over = {}) => store.putContinuation(u.id, chat, { summary: 'The user wants SQLite.', contentHash: HASH, coveredTurns: 8, source: 'server', model: 'm', inputTokens: 100, outputTokens: 20, ...over });

test('put then get round-trips; a second put replaces; another user sees nothing', () => {
  const u = mk(); const other = mk();
  put(u, 'chat-1');
  const got = store.getContinuation(u.id, 'chat-1');
  assert.equal(got.summary, 'The user wants SQLite.');
  assert.equal(got.contentHash, HASH);
  assert.equal(got.coveredTurns, 8);
  assert.equal(got.source, 'server');
  assert.equal(got.inputTokens, 100);
  put(u, 'chat-1', { summary: 'Newer.', contentHash: 'b'.repeat(64), coveredTurns: 10 });
  assert.equal(store.getContinuation(u.id, 'chat-1').summary, 'Newer.');
  assert.equal(store.getContinuation(other.id, 'chat-1'), null);
});

test('the summary is redacted and capped at the write; bad input is refused', () => {
  const u = mk();
  const secret = `sk-ant-api03-${'A1b2C3d4'.repeat(10)}`;
  put(u, 'chat-r', { summary: `configure it with ${secret} ${'x'.repeat(30_000)}` });
  const got = store.getContinuation(u.id, 'chat-r');
  assert.ok(!got.summary.includes(secret));
  assert.ok(got.summary.length <= store.CONTINUATION_SUMMARY_MAX + 100);
  assert.throws(() => put(u, 'chat-r', { summary: '  ' }), /summary/);
  assert.throws(() => put(u, 'chat-r', { contentHash: 'nothex' }), /contentHash/);
  assert.throws(() => put(u, 'chat-r', { source: 'phone' }), /source/);
});

test('a server row goes with the chat: delete and clear', () => {
  const u = mk();
  const a = createChatSession(u.id, { title: 'a' });
  appendChatMessage(u.id, a.id, { role: 'user', content: 'hi' });
  put(u, a.id);
  assert.equal(clearChatMessages(u.id, a.id), 1);
  assert.equal(store.getContinuation(u.id, a.id), null);
  const b = createChatSession(u.id, { title: 'b' });
  put(u, b.id);
  deleteChatSession(u.id, b.id);
  assert.equal(store.getContinuation(u.id, b.id), null);
});

test('the quit purge drops client-made rows only; account delete drops everything', () => {
  const u = mk();
  put(u, 'server-chat', { source: 'server' });
  put(u, 'client-chat', { source: 'client' });
  purgeWorkingState(u.id, ['server-chat', 'client-chat']);
  assert.ok(store.getContinuation(u.id, 'server-chat'));
  assert.equal(store.getContinuation(u.id, 'client-chat'), null);
  deleteUserCascade(u.id);
  assert.equal(store.getContinuation(u.id, 'server-chat'), null);
});

test.after(() => { closeDb(); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });

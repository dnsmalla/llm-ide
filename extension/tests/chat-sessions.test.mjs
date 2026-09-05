import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_chat-sessions-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function provision(email) {
  return users.registerUser(db.getDb(), {
    email,
    password: 'CorrectHorseBattery',
    displayName: email.split('@')[0],
  });
}

test('create, append, list messages chronological', () => {
  reset();
  const u = provision('chat@example.test');
  const session = db.createChatSession(u.id, { title: 'Meeting chat', surface: 'extension', mode: 'transcript' });
  db.appendChatMessage(u.id, session.id, { role: 'user', content: 'hello' });
  db.appendChatMessage(u.id, session.id, { role: 'assistant', content: 'hi there' });

  const loaded = db.getChatSession(u.id, session.id);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].role, 'user');
  assert.equal(loaded.messages[1].content, 'hi there');
});

test('appendChatMessage redacts secrets at the write — a pasted key never reaches chat_messages', () => {
  reset();
  const u = provision('redact@example.test');
  const session = db.createChatSession(u.id, { title: 'Setup', surface: 'extension', mode: 'transcript' });
  const key = 'sk-ant-api03-' + 'k'.repeat(30);
  const laced = 'AKIA' + 'Q'.repeat(8) + '\u200B' + 'Q'.repeat(8);
  db.appendChatMessage(u.id, session.id, {
    role: 'user',
    content: `configure it with ${key} and ${laced} please`,
    meta: { attachment: `token ${key}` },
  });
  const loaded = db.getChatSession(u.id, session.id);
  assert.equal(loaded.messages[0].content, 'configure it with [REDACTED] and [REDACTED] please');
  const dump = JSON.stringify(loaded);
  assert.equal(dump.includes(key), false, 'raw key must not survive in content or meta');
  assert.equal(dump.includes('QQQQQQQQ'), false, 'laced key must not survive');
});

test('session titles are redacted on create and update — titles are often the first message', () => {
  reset();
  const u = provision('title-redact@example.test');
  const key = 'ghp_' + 'a'.repeat(36);
  const session = db.createChatSession(u.id, { title: `Set up ${key}`, surface: 'extension', mode: 'ask' });
  assert.equal(session.title, 'Set up [REDACTED]');
  db.updateChatSession(u.id, session.id, { title: `Rotate ${key} now` });
  const loaded = db.getChatSession(u.id, session.id);
  assert.equal(loaded.title, 'Rotate [REDACTED] now');
  assert.equal(JSON.stringify(db.listChatSessions(u.id)).includes(key), false);
});

test('sessions are isolated per user', () => {
  reset();
  const a = provision('a@example.test');
  const b = provision('b@example.test');
  const sa = db.createChatSession(a.id, { surface: 'extension', mode: 'transcript' });
  db.appendChatMessage(a.id, sa.id, { role: 'user', content: 'secret' });

  const sb = db.createChatSession(b.id, { surface: 'extension', mode: 'transcript' });
  db.appendChatMessage(b.id, sb.id, { role: 'user', content: 'other' });

  const loadedB = db.getChatSession(b.id, sa.id);
  assert.equal(loadedB, null);
});

test('clear messages empties transcript', () => {
  reset();
  const u = provision('clear@example.test');
  const session = db.createChatSession(u.id, { mode: 'transcript' });
  db.appendChatMessage(u.id, session.id, { role: 'user', content: 'x' });
  db.clearChatMessages(u.id, session.id);
  const loaded = db.getChatSession(u.id, session.id);
  assert.equal(loaded.messages.length, 0);
});

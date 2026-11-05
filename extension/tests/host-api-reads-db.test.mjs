// Host API v1 reads against the real stores: default read deps, per-user scoping, paging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-reads-db-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const chats = await import('../kb/chat-sessions.mjs');
const { createGateway } = await import('../routes/host-api/gateway.mjs');

const HELLO = { clientName: 't', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });
const user = (tag) => users.registerUser(kb.getDb(), { email: `reads-${tag}-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: tag }).id;

function gatewayFor(userId) {
  const sent = [];
  const g = createGateway({
    send: (_s, text) => sent.push(JSON.parse(text)),
    close: () => {},
    hostName: () => 'Test Computer',
    capabilities: () => ['host', 'chat', 'approvals', 'read'],
    pins: { consumePin: (pin) => (pin === '123456' ? userId : null) },
    devices: {
      issueDeviceToken: (_u, _n, _now, scopes) => ({ deviceId: `h1-${userId}`, token: `tok-${userId}-0123456789`, scopes }),
      authenticateDeviceToken: () => null,
      revokeDevice: () => true,
    },
    quickChat: { get: () => null, set: () => {}, create: () => 'unused' },
  });
  const s = {};
  return {
    sent, last: () => sent.at(-1),
    async open() {
      g.opened(s, '127.0.0.1');
      await g.receive(s, req('c-h', 'host.hello', HELLO));
      await g.receive(s, req('c-p', 'host.auth.pair', { pin: '123456' }));
    },
    ask: (id, command, payload) => g.receive(s, req(id, command, payload)),
  };
}

test('a user reads only their own chats; another user\'s id is not_found', async () => {
  const a = user('a');
  const b = user('b');
  const chat = chats.createChatSession(a, { title: 'Router work', surface: 'any', mode: 'ask' });
  for (let i = 0; i < 5; i += 1) chats.appendChatMessage(a, chat.id, { role: i % 2 ? 'assistant' : 'user', content: `line ${i}` });

  const ga = gatewayFor(a);
  await ga.open();
  await ga.ask('c-1', 'chat.sessions', {});
  assert.equal(ga.last().type, 'response');
  assert.deepEqual(ga.last().result.sessions.map((x) => x.title), ['Router work']);
  assert.ok(ga.last().result.sessions[0].updatedAt > 1_000_000_000_000, 'milliseconds');

  await ga.ask('c-2', 'chat.history', { sessionId: chat.id, limit: 2 });
  const page = ga.last().result;
  assert.deepEqual(page.messages.map((m) => m.content), ['line 3', 'line 4']);
  assert.equal(typeof page.nextBeforeSeq, 'number');
  await ga.ask('c-3', 'chat.history', { sessionId: chat.id, limit: 2, beforeSeq: page.nextBeforeSeq });
  assert.deepEqual(ga.last().result.messages.map((m) => m.content), ['line 1', 'line 2']);

  const gb = gatewayFor(b);
  await gb.open();
  await gb.ask('c-1', 'chat.history', { sessionId: chat.id });
  assert.equal(gb.last().error.code, 'not_found');
  await gb.ask('c-2', 'chat.sessions', {});
  assert.deepEqual(gb.last().result.sessions, []);
});

test('usage.get answers a valid shape for a fresh user from the real usage store', async () => {
  const g = gatewayFor(user('u'));
  await g.open();
  await g.ask('c-1', 'usage.get', {});
  assert.equal(g.last().type, 'response', JSON.stringify(g.last()));
  assert.ok(Array.isArray(g.last().result.providers));
});

// Host API v1 per-project chat history (API 128): one phone chat per (user, project), a scoped list,
// a history request refused when the session belongs to another project, and the legacy/global NULL
// sessions left untouched by migration 0074. The gateway runs against the real stores; only the engine
// turn, devices and PIN are fakes, so no model call or network happens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-project-chat-'));
process.env.LLMIDE_DB_PATH = path.join(root, 'kb.db');

const { getDb } = await import('../kb/db.mjs');
const { registerProject } = await import('../kb/projects.mjs');
const { grant } = await import('./helpers/grant.mjs');
const chats = await import('../kb/chat-sessions.mjs');
const { setQuickChatId } = await import('../kb/host-api-devices.mjs');
const { createGateway } = await import('../routes/host-api/gateway.mjs');

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

const HELLO = { clientName: 't', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });
const flush = () => new Promise((r) => setImmediate(r));

let seq = 0;
function user(teamRole = 'member') {
  const id = `u-${++seq}`;
  getDb().prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, 'N', 'x', 'user', 'active')")
    .run(id, `chat-${seq}@example.com`);
  grant(getDb(), id, { teamRole, maxMode: 'execute', usdCapMonth: 0 });
  return id;
}

const owner = user('owner');
registerProject(getDb(), owner, { id: 'p-alpha', name: 'Alpha', root: '/work/alpha' });
registerProject(getDb(), owner, { id: 'p-beta', name: 'Beta', root: '/work/beta' });

function gatewayFor(userId, { projectRequired = false } = {}) {
  const sent = [];
  const turns = [];
  const g = createGateway({
    send: (_s, text) => sent.push(JSON.parse(text)),
    close: () => {},
    hostName: () => 'Test Computer',
    capabilities: () => ['host', 'chat', 'approvals', 'read', 'compose'],
    member: () => ({ teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 }),
    projectRequired: () => projectRequired,
    chatClearEnabled: () => true,
    pins: { consumePin: (pin) => (pin === '123456' ? userId : null) },
    devices: {
      issueDeviceToken: (_u, _n, _now, scopes) => ({ deviceId: `h1-${userId}`, token: `tok-${userId}-0123456789`, scopes }),
      authenticateDeviceToken: () => null,
      revokeDevice: () => true,
    },
    turn: (args) => {
      turns.push(args);
      args.onEvent({ type: 'init', sessionId: `sdk-${turns.length}` });
      args.onEvent({ type: 'delta', text: `ok ${turns.length}` });
      args.onEvent({ type: 'result', subtype: 'success' });
      return Promise.resolve();
    },
    log: () => {},
    audit: () => {},
  });
  const s = {};
  return {
    sent, turns,
    last: () => sent.at(-1),
    lastError: () => sent.at(-1).error,
    async open() {
      g.opened(s, '127.0.0.1');
      await g.receive(s, req('c-h', 'host.hello', HELLO));
      await g.receive(s, req('c-p', 'host.auth.pair', { pin: '123456' }));
    },
    ask: (id, command, payload) => g.receive(s, req(id, command, payload)),
  };
}

test('two projects, one user: chat.new creates a separate phone chat in each project', async () => {
  const g = gatewayFor(owner);
  await g.open();

  await g.ask('c-new-a', 'chat.new', { projectId: 'p-alpha' });
  assert.equal(g.last().type, 'response', JSON.stringify(g.last()));
  const alpha = g.last().result.sessionId;
  await g.ask('c-new-b', 'chat.new', { projectId: 'p-beta' });
  const beta = g.last().result.sessionId;
  assert.notEqual(alpha, beta);

  const a = chats.getChatSession(owner, alpha);
  const b = chats.getChatSession(owner, beta);
  assert.equal(a.projectId, 'p-alpha');
  assert.equal(b.projectId, 'p-beta');

  await g.ask('c-list-a', 'chat.sessions', { projectId: 'p-alpha' });
  assert.deepEqual(g.last().result.sessions.map((s) => s.id), [alpha]);
  assert.equal(g.last().result.sessions[0].phoneChat, true, 'the project chat is the live one');
  await g.ask('c-list-b', 'chat.sessions', { projectId: 'p-beta' });
  assert.deepEqual(g.last().result.sessions.map((s) => s.id), [beta]);
  // Switching back never shows the other project's chat.
  await g.ask('c-list-a2', 'chat.sessions', { projectId: 'p-alpha' });
  assert.deepEqual(g.last().result.sessions.map((s) => s.id), [alpha]);
});

test('a turn runs on the frame project\'s own chat, never the other project\'s', async () => {
  const g = gatewayFor(owner);
  await g.open();
  await g.ask('c-new-a', 'chat.new', { projectId: 'p-alpha' });
  const alpha = g.last().result.sessionId;
  await g.ask('c-new-b', 'chat.new', { projectId: 'p-beta' });
  const beta = g.last().result.sessionId;

  await g.ask('c-send-a', 'chat.send', { projectId: 'p-alpha', text: 'alpha question' });
  await flush();
  assert.equal(g.turns.at(-1).chatSessionId, alpha);
  assert.equal(g.turns.at(-1).projectId, 'p-alpha');
  await g.ask('c-send-b', 'chat.send', { projectId: 'p-beta', text: 'beta question' });
  await flush();
  assert.equal(g.turns.at(-1).chatSessionId, beta);
  assert.equal(g.turns.at(-1).projectId, 'p-beta');

  assert.deepEqual(chats.getChatSession(owner, alpha).messages.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(chats.getChatSession(owner, beta).messages.map((m) => m.role), ['user', 'assistant']);
});

test('history of another project\'s session is refused (the frame\'s 403 class) with PROJECT_MISMATCH', async () => {
  const g = gatewayFor(owner);
  await g.open();
  await g.ask('c-new-a', 'chat.new', { projectId: 'p-alpha' });
  const alpha = g.last().result.sessionId;

  await g.ask('c-mismatch', 'chat.history', { projectId: 'p-beta', sessionId: alpha });
  assert.equal(g.last().type, 'error');
  assert.equal(g.lastError().code, 'denied', 'denied is the Host API error frame\'s 403 class');
  assert.match(g.lastError().message, /PROJECT_MISMATCH/);

  await g.ask('c-ok', 'chat.history', { projectId: 'p-alpha', sessionId: alpha });
  assert.equal(g.last().type, 'response');
  assert.deepEqual(g.last().result.messages, []);
});

test('legacy/global NULL sessions: listed only without a project, and never read through a project', async () => {
  const legacyUser = user('member');
  const legacy = chats.createChatSession(legacyUser, { title: 'Phone chat', surface: 'any', mode: 'agent' });
  chats.appendChatMessage(legacyUser, legacy.id, { role: 'user', content: 'from before projects' });
  setQuickChatId(legacyUser, legacy.id); // the pre-0074 global pointer, copied to project_id ''

  const g = gatewayFor(legacyUser);
  await g.open();
  await g.ask('c-list-legacy', 'chat.sessions', {});
  assert.deepEqual(g.last().result.sessions.map((s) => s.id), [legacy.id]);
  assert.equal(g.last().result.sessions[0].phoneChat, true);

  await g.ask('c-hist-legacy', 'chat.history', { sessionId: legacy.id });
  assert.equal(g.last().type, 'response');
  assert.deepEqual(g.last().result.messages.map((m) => m.content), ['from before projects']);

  await g.ask('c-hist-project', 'chat.history', { projectId: 'p-alpha', sessionId: legacy.id });
  assert.equal(g.last().type, 'error');
  assert.match(g.lastError().message, /PROJECT_MISMATCH/);

  await g.ask('c-list-project', 'chat.sessions', { projectId: 'p-alpha' });
  assert.deepEqual(g.last().result.sessions, [], 'the legacy chat is not part of a project');
});

test('hub: a project-scoped Host API command without projectId is refused PROJECT_REQUIRED', async () => {
  const g = gatewayFor(owner, { projectRequired: true });
  await g.open();

  await g.ask('c-hub-list', 'chat.sessions', {});
  assert.equal(g.last().type, 'error');
  assert.equal(g.lastError().code, 'denied');
  assert.match(g.lastError().message, /PROJECT_REQUIRED/);
  assert.equal(g.turns.length, 0);

  await g.ask('c-hub-send', 'chat.send', { text: 'no project' });
  assert.equal(g.lastError().code, 'denied');
  assert.match(g.lastError().message, /PROJECT_REQUIRED/);
  assert.equal(g.turns.length, 0, 'no turn starts without a project on a hub');

  await g.ask('c-hub-new', 'chat.new', { projectId: 'p-alpha' });
  assert.equal(g.last().type, 'response');
  await g.ask('c-hub-send-ok', 'chat.send', { projectId: 'p-alpha', text: 'scoped' });
  await flush();
  assert.equal(g.turns.length, 1);
  assert.equal(g.turns[0].projectId, 'p-alpha');
});

test('unassigned project member is a viewer: Ask only, and the list is still scoped', async () => {
  const outsider = user('member');
  const g = gatewayFor(outsider);
  await g.open();

  await g.ask('c-list', 'chat.sessions', { projectId: 'p-alpha' });
  assert.equal(g.last().type, 'response', 'self.read is a viewer class');
  assert.deepEqual(g.last().result.sessions, []);

  await g.ask('c-ask', 'chat.send', { projectId: 'p-alpha', text: 'read only question' });
  await flush();
  assert.equal(g.turns.length, 1, 'a viewer may Ask');
});

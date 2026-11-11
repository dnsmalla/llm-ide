// Host API v1 Loop commands (loop.issues/list/start/cancel) over the real command bus and stores. Was: per-project chat (API 128): one phone chat per (user, project), a scoped list,
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-loop-'));
process.env.LLMIDE_DB_PATH = path.join(root, 'kb.db');

const { getDb } = await import('../kb/db.mjs');
const { registerProject } = await import('../kb/projects.mjs');
const { grant } = await import('./helpers/grant.mjs');
const chats = await import('../kb/chat-sessions.mjs');
const { createBus } = await import('../routes/bus/executor.mjs');
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
    .run(id, `loop-${seq}@example.com`);
  grant(getDb(), id, { teamRole, maxMode: 'execute', usdCapMonth: 0 });
  return id;
}
const owner = user('owner');
const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-loop-proj-'));
registerProject(getDb(), owner, { id: 'p-alpha', name: 'Alpha', root: projRoot });
registerProject(getDb(), owner, { id: 'p-beta', name: 'Beta', root: '/work/beta' });
const bus = createBus({ logger: { info() {}, warn() {}, error() {} }, deps: { resolveProjectRoot: (_u, id) => { if (id !== 'p-alpha') throw new Error('unknown'); return projRoot; } } });

function gatewayFor(userId, { member = { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 }, withBus = true } = {}) {
  const sent = [];
  const g = createGateway({
    send: (_s, text) => sent.push(JSON.parse(text)), close: () => {}, hostName: () => 'T',
    capabilities: () => ['host', 'chat', 'approvals', 'read', 'compose'],
    member: () => member, projectRequired: () => false, chatClearEnabled: () => true,
    bus: () => (withBus ? bus : null),
    pins: { consumePin: (pin) => (pin === '123456' ? userId : null) },
    devices: { issueDeviceToken: (_u, _n, _now, scopes) => ({ deviceId: `h-${userId}`, token: `tok-${userId}-0123456789`, scopes }), authenticateDeviceToken: () => null, revokeDevice: () => true },
    turn: () => Promise.resolve(), log: () => {}, audit: () => {},
  });
  const s = {};
  return {
    sent, last: () => sent.at(-1),
    async open() { g.opened(s, '127.0.0.1'); await g.receive(s, req('c-h', 'host.hello', HELLO)); await g.receive(s, req('c-p', 'host.auth.pair', { pin: '123456' })); },
    ask: (id, command, payload) => g.receive(s, req(id, command, payload)),
  };
}

test('loop.start queues an approval-gated issues.implement; loop.list shows it; loop.cancel ends it', async () => {
  const g = gatewayFor(owner); await g.open();
  await g.ask('l-1', 'loop.start', { projectId: 'p-alpha', issueIds: ['issue-0001', 'issue-0002'] });
  assert.equal(g.last().type, 'response', JSON.stringify(g.last()));
  const { id, state } = g.last().result;
  assert.equal(state, 'awaiting_approval', 'a phone start waits for the desktop');
  await g.ask('l-2', 'loop.list', { projectId: 'p-alpha' });
  assert.deepEqual(g.last().result.runs.map((r) => [r.id, r.state, r.issueCount]), [[id, 'awaiting_approval', 2]]);
  await g.ask('l-3', 'loop.list', { projectId: 'p-beta' });
  assert.deepEqual(g.last().result.runs, [], 'another project never sees it');
  await g.ask('l-4', 'loop.cancel', { id });
  assert.deepEqual(g.last().result, { cancelled: true });
  await g.ask('l-5', 'loop.list', {});
  assert.equal(g.last().result.runs[0].state, 'cancelled');
  await g.ask('l-6', 'loop.cancel', { id });
  assert.equal(g.last().type, 'response'); // idempotent
});

test('loop.start is refused for a viewer, without a bus, and for an unknown project', async () => {
  const viewer = gatewayFor(owner, { member: { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 0 } }); await viewer.open();
  await viewer.ask('v-1', 'loop.start', { projectId: 'p-alpha', issueIds: ['issue-0001'] });
  assert.equal(viewer.last().error?.code, 'denied');
  const nobus = gatewayFor(owner, { withBus: false }); await nobus.open();
  await nobus.ask('n-1', 'loop.start', { projectId: 'p-alpha', issueIds: ['issue-0001'] });
  assert.equal(nobus.last().error?.code, 'capability_unavailable');
  const g = gatewayFor(owner); await g.open();
  await g.ask('u-1', 'loop.start', { projectId: 'p-missing', issueIds: ['issue-0001'] });
  assert.equal(g.last().error?.code, 'not_found');
});

test('loop.cancel refuses a command that is not a Loop run', async () => {
  const g = gatewayFor(owner); await g.open();
  await g.ask('x-1', 'loop.cancel', { id: 'no-such-command' });
  assert.equal(g.last().error?.code, 'not_found');
});

test('loop.issues answers an empty list when nothing is cached', async () => {
  const g = gatewayFor(owner); await g.open();
  await g.ask('i-1', 'loop.issues', { projectId: 'p-alpha' });
  assert.deepEqual(g.last().result, { issues: [] });
});

// Host API v1 token scopes (Plan 6 Task 7) — the Node twin of the retired Swift app's HostApiV1ScopesTests.swift.
// A token carries the capabilities served when it was paired; a session's effective set is served ∩ granted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-scopes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const dev = await import('../kb/host-api-devices.mjs');
const { createGateway } = await import('../routes/host-api/gateway.mjs');

const HELLO = { clientName: 't', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });

function harness({ toolApprovals = false } = {}) {
  const t = { sent: [], decided: [], turns: [], toolApprovals };
  const tokens = new Map(); // token -> { userId, deviceId, scopes }
  let n = 0;
  t.tokens = tokens;
  t.g = createGateway({
    send: (s, text) => t.sent.push([s, JSON.parse(text)]),
    close: () => {},
    hostName: () => 'Test Computer',
    capabilities: () => ['host', 'chat', 'approvals', ...(t.toolApprovals ? ['tool_approvals'] : [])],
    // ADR 0021: the paired account is this install's owner (the pre-team fixture world had no roles).
    member: () => ({ teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 }),
    log: () => {},
    chatClearEnabled: () => false,
    pins: { consumePin: (pin) => (pin === '123456' ? 'u1' : null) },
    devices: {
      issueDeviceToken(userId, _name, _now, scopes = null) {
        n += 1;
        const deviceId = `h1-dev${n}`;
        const token = `tok-${deviceId}-0123456789`;
        tokens.set(token, { userId, deviceId, scopes });
        return { deviceId, token };
      },
      authenticateDeviceToken(token) {
        const d = tokens.get(token);
        return d ? { userId: d.userId, deviceId: d.deviceId, scopes: d.scopes ?? [...dev.LEGACY_SCOPES] } : null;
      },
      revokeDevice: () => true,
    },
    quickChat: { get: () => 'chat-1', set: () => {}, create: () => 'chat-1' },
    history: async () => [],
    append: () => {},
    turn: (args) => { t.turns.push(args); args.onEvent({ type: 'init', sessionId: 'sdk-1' }); return new Promise(() => {}); },
    cancel: () => true,
    clear: () => ({ cleared: true }),
    decide: (args) => { t.decided.push(args); return { ok: true }; },
  });
  t.last = () => t.sent.at(-1)[1];
  t.open = async (s, auth) => {
    t.g.opened(s, '127.0.0.1');
    await t.g.receive(s, req('c-h', 'host.hello', HELLO));
    await t.g.receive(s, auth);
    return t.last();
  };
  // Starts a turn that raises a tool approval, then answers it.
  t.answerTool = async (s) => {
    await t.g.receive(s, req('c-9', 'chat.send', { text: 'hello' }));
    t.turns.at(-1).onEvent({ type: 'approval_request', requestId: 'r2', kind: 'ToolApproval', toolName: 'Bash', argsSummary: 'ls' });
    await t.g.receive(s, req('c-t', 'toolApprovals.answer', { requestId: 'r2', commandId: 'c-9', decision: 'allow_once' }));
    return t.last();
  };
  return t;
}

const PAIR = req('c-p', 'host.auth.pair', { pin: '123456' });

test('a capability turned on after pairing is not granted: the push leaves it out and the answer is denied', async () => {
  const t = harness();
  const s = {};
  assert.deepEqual((await t.open(s, PAIR)).result.capabilities, ['host', 'chat', 'approvals']);
  t.toolApprovals = true;
  const before = t.sent.length;
  t.g.capabilitiesChanged();
  assert.equal(t.sent.length, before, 'the session\'s own list did not change, so nothing is pushed');
  await t.g.receive(s, req('c-t', 'toolApprovals.answer', { requestId: 'r2', commandId: 'c-9', decision: 'allow_once' }));
  assert.equal(t.last().error.code, 'denied');
  assert.match(t.last().error.message, /pair again/);
  assert.equal(t.decided.length, 0);
});

test('paired while served: the token grants tool_approvals on a new session and the answer is accepted', async () => {
  const t = harness({ toolApprovals: true });
  const pair = await t.open({ n: 1 }, PAIR);
  assert.deepEqual(pair.result.capabilities, ['host', 'chat', 'approvals', 'tool_approvals']);
  const s2 = { n: 2 };
  const auth = await t.open(s2, req('c-t', 'host.auth.token', { token: pair.result.token }));
  assert.deepEqual(auth.result.capabilities, ['host', 'chat', 'approvals', 'tool_approvals']);
  assert.deepEqual((await t.answerTool(s2)).result, { accepted: true });
});

test('a legacy token (no stored scopes) gets host, chat and approvals, never tool_approvals', async () => {
  const t = harness({ toolApprovals: true });
  t.tokens.set('legacy-token-0123456789', { userId: 'u1', deviceId: 'h1-old', scopes: null });
  const s = {};
  const auth = await t.open(s, req('c-t', 'host.auth.token', { token: 'legacy-token-0123456789' }));
  assert.deepEqual(auth.result.capabilities, ['host', 'chat', 'approvals']);
  assert.equal((await t.answerTool(s)).error.code, 'denied');
});

test('granted but no longer served: capability_unavailable, and the push drops it', async () => {
  const t = harness({ toolApprovals: true });
  const s = {};
  await t.open(s, PAIR);
  t.toolApprovals = false;
  t.g.capabilitiesChanged();
  assert.equal(t.last().command, 'host.capabilities');
  assert.deepEqual(t.last().payload.capabilities, ['host', 'chat', 'approvals']);
  await t.g.receive(s, req('c-t', 'toolApprovals.answer', { requestId: 'r2', commandId: 'c-9', decision: 'allow_once' }));
  assert.equal(t.last().error.code, 'capability_unavailable');
  t.toolApprovals = true;
  t.g.capabilitiesChanged();
  assert.ok(t.last().payload.capabilities.includes('tool_approvals'), 'granted again once served');
});

test('store: scopes round-trip through the column; NULL scopes read as the legacy set', () => {
  const u = users.registerUser(kb.getDb(), { email: `scopes-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'h' }).id;
  const a = dev.issueDeviceToken(u, 'web', Date.now(), ['host', 'chat']);
  assert.deepEqual(dev.authenticateDeviceToken(a.token), { userId: u, deviceId: a.deviceId, scopes: ['host', 'chat'] });
  const b = dev.issueDeviceToken(u, 'old');
  assert.equal(kb.getDb().prepare('SELECT scopes FROM host_api_devices WHERE device_id = ?').get(b.deviceId).scopes, null);
  assert.deepEqual(dev.authenticateDeviceToken(b.token).scopes, ['host', 'chat', 'approvals']);
  assert.ok(Object.isFrozen(dev.LEGACY_SCOPES));
});

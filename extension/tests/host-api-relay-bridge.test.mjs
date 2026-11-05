// Relay bridge → Host API gateway tier caps (relay plan Task 8). No sockets except the upgrade-gate shape checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createGateway } = await import('../routes/host-api/gateway.mjs');
const { bridgeRefusal } = await import('../server/relay-bridge.mjs');
const { busHostProof, BUS_PROOF_HEADER } = await import('../core/host-approval.mjs');

const HELLO = { clientName: 't', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });

function harness() {
  const t = { sent: [], tokens: new Map() }; let n = 0;
  t.g = createGateway({
    send: (s, text) => t.sent.push([s, JSON.parse(text)]), close: () => {}, hostName: () => 'Test Computer',
    capabilities: () => ['host', 'chat', 'approvals', 'read'], log: () => {}, chatClearEnabled: () => false,
    pins: { consumePin: (pin) => (pin === '123456' ? 'u1' : null) },
    devices: {
      issueDeviceToken(userId, _name, _now, scopes = null) { n += 1; const deviceId = `h1-dev${n}`; const token = `tok-${deviceId}-0123456789`; t.tokens.set(token, { userId, deviceId, scopes }); return { deviceId, token }; },
      authenticateDeviceToken(token) { const d = t.tokens.get(token); return d ? { userId: d.userId, deviceId: d.deviceId, scopes: d.scopes } : null; },
      revokeDevice: () => true,
    },
    quickChat: { get: () => 'chat-1', set: () => {}, create: () => 'chat-1' }, history: async () => [], append: () => {},
    turn: () => new Promise(() => {}), cancel: () => true, clear: () => ({ cleared: true }), decide: () => ({ ok: true }),
  });
  t.last = () => t.sent.at(-1)[1];
  return t;
}
const wait = () => new Promise((r) => setTimeout(r, 10));

test('a web-tier bridge session pairs and is granted host, chat, read only', async () => {
  const t = harness(); const s = { id: 'b1', relayTier: 'web' };
  t.g.opened(s, '127.0.0.1');
  t.g.receive(s, req('h', 'host.hello', HELLO)); await wait();
  t.g.receive(s, req('p', 'host.auth.pair', { pin: '123456' })); await wait();
  assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'read']);
  assert.deepEqual([...t.tokens.values()][0].scopes, ['host', 'chat', 'read']);
});

test('a full-scope token used on a web-tier bridge is still capped', async () => {
  const t = harness(); const lan = { id: 'lan' };
  t.g.opened(lan, '10.0.0.5');
  t.g.receive(lan, req('h', 'host.hello', HELLO)); await wait();
  t.g.receive(lan, req('p', 'host.auth.pair', { pin: '123456' })); await wait();
  const token = t.last().result.token;
  const s = { id: 'b2', relayTier: 'web' };
  t.g.opened(s, '127.0.0.1');
  t.g.receive(s, req('h2', 'host.hello', HELLO)); await wait();
  t.g.receive(s, req('a', 'host.auth.token', { token })); await wait();
  assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'read']);
});

test('bridge upgrade needs the exact path, loopback peer, no Origin, the host proof and a known tier', () => {
  const env = { LLMIDE_HOST_APPROVAL_KEY: 'c'.repeat(64) };
  const good = { method: 'GET', url: '/host-api/relay-bridge', socket: { remoteAddress: '127.0.0.1' },
    headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16).toString('base64'), [BUS_PROOF_HEADER]: busHostProof(env), 'x-llmide-relay-tier': 'web' } };
  assert.equal(bridgeRefusal(good, env), null);
  assert.equal(bridgeRefusal({ ...good, url: '/host-api/relay-bridge?x=1' }, env), 404);
  assert.equal(bridgeRefusal({ ...good, socket: { remoteAddress: '10.0.0.2' } }, env), 403);
  assert.equal(bridgeRefusal({ ...good, headers: { ...good.headers, origin: 'http://evil' } }, env), 403);
  assert.equal(bridgeRefusal({ ...good, headers: { ...good.headers, [BUS_PROOF_HEADER]: 'f'.repeat(64) } }, env), 403);
  assert.equal(bridgeRefusal({ ...good, headers: { ...good.headers, 'x-llmide-relay-tier': 'admin' } }, env), 400);
  assert.equal(bridgeRefusal(good, {}), 403, 'no approval key: nobody can prove host');
});

// Host API v1 `push` on the desktop gateway, with injected fakes (no DB, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, hostApiCapabilities } from '../routes/host-api/gateway.mjs';

const SEC = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../schema/host-api/v1/fixtures/security/push.json'), 'utf8'));
const HELLO = { clientName: 't', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });
const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const WEB = { kind: 'webpush', endpoint: 'https://fcm.googleapis.com/fcm/send/secret-endpoint', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };

function harness() {
  const t = { sent: [], audits: [], regs: [], unregs: [], served: true };
  const tokens = new Map();
  let n = 0;
  t.g = createGateway({
    send: (_s, text) => t.sent.push(JSON.parse(text)), close: () => {}, hostName: () => 'Test Computer', log: () => {},
    capabilities: () => ['host', 'chat', 'approvals', ...(t.served ? ['push'] : [])],
    // ADR 0021: the paired account is this install's owner (the pre-team fixture world had no roles).
    member: () => ({ teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 }),
    pins: { consumePin: (pin) => (pin === '123456' ? 'u1' : null) },
    devices: {
      issueDeviceToken(userId, _name, _now, scopes) { n += 1; const deviceId = `h1-dev${n}`; const token = `tok-${deviceId}-0123456789`; tokens.set(token, { userId, deviceId, scopes }); return { deviceId, token }; },
      authenticateDeviceToken: (token) => tokens.get(token) ?? null,
      revokeDevice: () => true,
    },
    audit: (event, f) => t.audits.push([event, f]),
    push: {
      config: () => ({ webPushKey: KEY, apns: false, registered: t.regs.length ? 'webpush' : 'none' }),
      register: (u, d, target) => { t.regs.push([u, d, target]); },
      unregister: (u, d) => { t.unregs.push([u, d]); return true; },
    },
  });
  t.last = () => t.sent.at(-1);
  t.pair = async (s) => { t.g.opened(s, '127.0.0.1'); await t.g.receive(s, req('h', 'host.hello', HELLO)); await t.g.receive(s, req('p', 'host.auth.pair', { pin: '123456' })); return t.last().result; };
  return t;
}

test('the push capability is served only with LLMIDE_HOST_API_PUSH=1', () => {
  assert.ok(!hostApiCapabilities({}).includes('push'));
  assert.ok(hostApiCapabilities({ LLMIDE_HOST_API_PUSH: '1' }).includes('push'));
});

test('a device paired while push is served configures, registers and unregisters', async () => {
  const t = harness();
  const s = { n: 1 };
  assert.ok((await t.pair(s)).capabilities.includes('push'));
  await t.g.receive(s, req('c1', 'push.config'));
  assert.deepEqual(t.last().result, { webPushKey: KEY, apns: false, registered: 'none' });
  await t.g.receive(s, req('c2', 'push.register', WEB));
  assert.deepEqual(t.last().result, { registered: true });
  assert.deepEqual(t.regs, [['u1', 'h1-dev1', WEB]]);
  const apns = { kind: 'apns', token: 'ab'.repeat(32), environment: 'production' };
  await t.g.receive(s, req('c3', 'push.register', apns));
  assert.deepEqual(t.regs[1][2], apns);
  await t.g.receive(s, req('c4', 'push.unregister'));
  assert.deepEqual(t.last().result, { removed: true });
  assert.deepEqual(t.audits.map(([e, f]) => [e, f.detail ?? null]), [['pair_ok', null], ['push_register', 'webpush fcm.googleapis.com'], ['push_register', 'apns production'], ['push_unregister', null]]);
  assert.ok(!JSON.stringify(t.audits).includes('secret-endpoint') && !JSON.stringify(t.audits).includes('abab'), 'no endpoint or token in the audit');
});

test('register refuses what the schema lets through but the host does not accept', async () => {
  const t = harness();
  const s = { n: 1 };
  await t.pair(s);
  const bad = [
    ...SEC.endpoints.refused.filter((e) => /^https:\/\/[!-~]+$/.test(e) && e.length >= 12).map((endpoint) => ({ ...WEB, endpoint })),
    { kind: 'webpush', endpoint: WEB.endpoint, auth: WEB.auth },
    { ...WEB, p256dh: `A${WEB.p256dh.slice(1)}` },
    { ...WEB, token: 'ab'.repeat(32) },
    { kind: 'apns', token: 'ab'.repeat(32) },
    { kind: 'apns', token: 'ab'.repeat(32), environment: 'sandbox', endpoint: WEB.endpoint },
  ];
  for (const [i, p] of bad.entries()) {
    await t.g.receive(s, req(`b${i}`, 'push.register', p));
    assert.equal(t.last().error?.code, 'invalid_payload', JSON.stringify(p));
  }
  assert.deepEqual(t.regs, []);
  assert.ok(t.audits.some(([e]) => e === 'push_refused'));
});

test('a device paired before push was served is denied with a re-pair hint; an unserved push is unavailable', async () => {
  const t = harness();
  t.served = false;
  const s = { n: 1 };
  const paired = await t.pair(s);
  t.served = true;
  await t.g.receive(s, req('c', 'push.register', WEB));
  assert.equal(t.last().error.code, 'denied');
  assert.match(t.last().error.message, /pair again/);
  const s2 = { n: 2 };
  t.served = false;
  t.g.opened(s2, '127.0.0.2');
  await t.g.receive(s2, req('h', 'host.hello', HELLO));
  await t.g.receive(s2, req('t', 'host.auth.token', { token: paired.token }));
  await t.g.receive(s2, req('c', 'push.config'));
  assert.equal(t.last().error.code, 'capability_unavailable');
});

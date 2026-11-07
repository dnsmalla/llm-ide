// The desktop's push sender: vault credentials, the gate and the fan-out (fake senders; real DB and vault).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-push-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();
after(wipe);

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const dev = await import('../kb/host-api-devices.mjs');
const pt = await import('../kb/push-targets.mjs');
const P = await import('../routes/host-api/push.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `q-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'q' }).id;
const PEM = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const WEB = { kind: 'webpush', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const APNS = { kind: 'apns', token: 'ab'.repeat(32), environment: 'sandbox' };
function fakes(results = {}) {
  const calls = [];
  return {
    calls,
    send: {
      webpush: async (t, plaintext, o) => { calls.push(['webpush', t.deviceId, plaintext, o.urgency, o.topic]); return results.webpush ?? { ok: true }; },
      apns: async (o) => { calls.push(['apns', o.token, o.payload, o.collapseId, o.environment]); return results.apns ?? { ok: true }; },
    },
  };
}

test('the VAPID key is made once, kept in the vault, and only its public half leaves', () => {
  const u = user();
  const a = P.vapidFor(u);
  assert.equal(P.vapidFor(u).publicKey, a.publicKey);
  assert.match(a.publicKey, /^[A-Za-z0-9_-]{87}$/);
  const raw = kb.getDb().prepare("SELECT ciphertext FROM user_secrets WHERE user_id = ? AND secret_key = 'push.vapidKey'").get(u).ciphertext;
  assert.ok(!String(raw).includes('"d"'), 'encrypted at rest');
  const { deviceId } = dev.issueDeviceToken(u, 'w', Date.now(), ['host', 'push']);
  assert.deepEqual(P.pushConfig(u, deviceId), { webPushKey: a.publicKey, apns: false, registered: 'none' });
});

test('APNs credentials: validated, stored, reported without the key, removable', () => {
  const u = user();
  assert.deepEqual(P.setApnsCredentials(u, { key: 'nope', keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' }), { ok: false, field: 'key' });
  assert.deepEqual(P.setApnsCredentials(u, { key: PEM, keyId: 'abc', teamId: '9A3YFRQ7SM' }), { ok: false, field: 'keyId' });
  assert.deepEqual(P.setApnsCredentials(u, { key: PEM, keyId: 'ABCDE12345', teamId: '' }), { ok: false, field: 'teamId' });
  assert.deepEqual(P.apnsStatus(u), { configured: false, keyId: null, teamId: null });
  assert.deepEqual(P.setApnsCredentials(u, { key: PEM, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' }), { ok: true, keyId: 'ABCDE12345' });
  assert.deepEqual(P.apnsStatus(u), { configured: true, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' });
  assert.ok(P.apnsCredentials(u).key);
  P.clearApnsCredentials(u);
  assert.deepEqual(P.apnsStatus(u), { configured: false, keyId: null, teamId: null });
});

test('the gate: each key once, one push per user and kind per 10 s, 10 then 30 an hour per device', () => {
  const g = P.createPushGate();
  const t = 1_000_000;
  assert.equal(g.admit('u', 'approval_job', 'a', t), true);
  assert.equal(g.admit('u', 'approval_job', 'a', t + 60_000), false, 'same key never twice');
  assert.equal(g.admit('u', 'approval_job', 'b', t + 1_000), false, 'a burst is coalesced');
  assert.equal(g.admit('u', 'approval_job', 'c', t + 11_000), true);
  assert.equal(g.admit('v', 'approval_job', 'c', t + 11_000), true, 'users are separate');
  assert.equal(g.admit('u', 'loop_done', null, t + 11_001), true, 'kinds are separate');
  let ok = 0;
  for (let i = 0; i < 12; i += 1) if (g.device('d', t)) ok += 1;
  assert.equal(ok, 10);
  assert.equal(g.device('d', t + 120_000), true, 'one back every 2 minutes');
});

test('fan-out: only granted devices with a target; payloads are the fixed kind and count', async () => {
  const u = user();
  const web = dev.issueDeviceToken(u, 'web', Date.now(), ['host', 'push']).deviceId;
  const phone = dev.issueDeviceToken(u, 'phone', Date.now(), ['host', 'push']).deviceId;
  const old = dev.issueDeviceToken(u, 'old', Date.now(), ['host', 'chat']).deviceId;
  pt.setPushTarget(u, web, WEB);
  pt.setPushTarget(u, phone, APNS);
  pt.setPushTarget(u, old, WEB);
  P.setApnsCredentials(u, { key: PEM, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' });
  const f = fakes();
  const out = await P.dispatchPush(u, { kind: 'approval_job', key: 'j1', count: 3 }, { gate: P.createPushGate(), served: true, send: f.send });
  assert.deepEqual(out, { sent: 2 });
  assert.deepEqual(f.calls.find((c) => c[0] === 'webpush'), ['webpush', web, '{"k":"approval_job","n":3}', 'high', 'approval_job']);
  const a = f.calls.find((c) => c[0] === 'apns');
  assert.deepEqual([a[1], a[3], a[4]], [APNS.token, 'approval_job', 'sandbox']);
  assert.equal(JSON.parse(a[2]).aps.alert['loc-key'], 'PUSH_APPROVAL_JOB_MANY');
  assert.equal(f.calls.length, 2, 'the device without a push grant got nothing');
  assert.deepEqual(pt.listPushTargets(u).filter((r) => r.deviceId !== old).map((r) => r.lastResult), ['ok', 'ok']);
});

test('fan-out: nothing when unserved or for a non-push kind; gone targets removed; no APNs key noted', async () => {
  const u = user();
  const web = dev.issueDeviceToken(u, 'web', Date.now(), ['host', 'push']).deviceId;
  const phone = dev.issueDeviceToken(u, 'phone', Date.now(), ['host', 'push']).deviceId;
  pt.setPushTarget(u, web, WEB);
  pt.setPushTarget(u, phone, APNS);
  const f = fakes({ webpush: { gone: true } });
  assert.deepEqual(await P.dispatchPush(u, { kind: 'loop_done' }, { gate: P.createPushGate(), served: false, send: f.send }), { sent: 0 });
  assert.deepEqual(await P.dispatchPush(u, { kind: 'core_down' }, { gate: P.createPushGate(), served: true, send: f.send }), { sent: 0 });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await P.dispatchPush(u, { kind: 'loop_done' }, { gate: P.createPushGate(), served: true, send: f.send }), { sent: 0 });
  assert.deepEqual(pt.listPushTargets(u).map((r) => [r.deviceId, r.lastResult]), [[phone, 'APNS_NOT_CONFIGURED']]);
});

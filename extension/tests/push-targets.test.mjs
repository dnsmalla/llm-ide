// Push targets of paired Host API devices: one per device, upserted, and gone with the device.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_push-targets-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();
after(wipe);

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const dev = await import('../kb/host-api-devices.mjs');
const pt = await import('../kb/push-targets.mjs');
const vault = await import('../server/vault.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `p-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'p' }).id;
const WEB = { kind: 'webpush', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) };
const APNS = { kind: 'apns', token: 'ab'.repeat(32), environment: 'sandbox' };

test('one target per device, upserted; listed with the device name and grant', () => {
  const u = user();
  const { deviceId } = dev.issueDeviceToken(u, 'Pixel', 1000, ['host', 'chat', 'push']);
  pt.setPushTarget(u, deviceId, WEB, 2000);
  assert.equal(pt.pushTargetKind(u, deviceId), 'webpush');
  pt.notePushResult(u, deviceId, 'ok', 3000);
  pt.setPushTarget(u, deviceId, APNS, 4000);
  const [row, ...rest] = pt.listPushTargets(u);
  assert.equal(rest.length, 0);
  assert.deepEqual(row, { deviceId, name: 'Pixel', scopes: ['host', 'chat', 'push'], kind: 'apns', endpoint: null, p256dh: null, auth: null, token: APNS.token, environment: 'sandbox', lastResult: null, lastAt: null });
  assert.equal(pt.clearPushTarget(u, deviceId), true);
  assert.equal(pt.clearPushTarget(u, deviceId), false);
  assert.equal(pt.pushTargetKind(u, deviceId), null);
});

test('revoking the device, or an identity reset, removes its target', () => {
  const u = user();
  const a = dev.issueDeviceToken(u, 'a', 1000, ['host', 'push']).deviceId;
  const b = dev.issueDeviceToken(u, 'b', 1000, ['host', 'push']).deviceId;
  pt.setPushTarget(u, a, WEB);
  pt.setPushTarget(u, b, APNS);
  dev.revokeDevice(u, a);
  assert.deepEqual(pt.listPushTargets(u).map((r) => r.deviceId), [b]);
  kb.getDb().prepare('DELETE FROM host_api_devices').run(); // what loadOrCreateHostIdentity does on a reset
  assert.deepEqual(pt.listPushTargets(u), []);
});

test('another user never sees or clears a target; a target needs a real device', () => {
  const u = user();
  const v = user();
  const { deviceId } = dev.issueDeviceToken(u, 'a', 1000, ['host', 'push']);
  pt.setPushTarget(u, deviceId, WEB);
  assert.deepEqual(pt.listPushTargets(v), []);
  assert.equal(pt.clearPushTarget(v, deviceId), false);
  assert.throws(() => pt.setPushTarget(u, 'h1-nope', WEB), /FOREIGN KEY/);
});

test('the push secrets are vault-internal: storable, never client-settable or listed', () => {
  const u = user();
  for (const k of ['push.vapidKey', 'push.apnsKey', 'push.apnsKeyId', 'push.apnsTeamId']) {
    assert.equal(vault.isUserSettableVaultKey(k), false, k);
    vault.setSecret(kb.getDb(), u, k, 'v');
    assert.equal(vault.getSecret(kb.getDb(), u, k), 'v');
    assert.ok(!vault.VAULT_KEYS.includes(k), k);
  }
  assert.deepEqual(vault.listSecretKeys(kb.getDb(), u).filter((r) => r.secret_key.startsWith('push.')), []);
});

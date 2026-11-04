process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-identity-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

const id = await import('../server/host-identity.mjs');
const { getDb } = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const dev = await import('../kb/host-api-devices.mjs');
const vector = JSON.parse(readFileSync(new URL('../../schema/host-api/v1/fixtures/security/identity-vector.json', import.meta.url)));

test('the fingerprint matches the shared vector', () => {
  assert.equal(id.fingerprintOfSpki(Buffer.from(vector.spkiDerBase64, 'base64')), vector.fingerprint);
});

test('the certificate parses, is self-signed, not a CA, for server auth, and holds the key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = id.buildSelfSignedCert({ privateKey, publicKey, commonName: 'LLM-IDE Test', notBefore: 1_760_000_000_000,
    notAfter: 1_760_000_000_000 + id.VALIDITY_MS, serial: Buffer.alloc(16, 0x7f) });
  const x = new X509Certificate(der);
  assert.equal(x.subject, 'CN=LLM-IDE Test');
  assert.equal(x.ca, false);
  assert.ok(x.verify(x.publicKey), 'self-signature verifies');
  assert.ok(x.checkPrivateKey(privateKey));
  assert.deepEqual(x.keyUsage, ['1.3.6.1.5.5.7.3.1']);
});

test('load-or-create persists one identity, encrypted; a vault change resets and wipes v1 devices', () => {
  const db = getDb();
  id.resetHostIdentity(db);
  const u = users.registerUser(db, { email: `id-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'h' }).id;
  const { token } = dev.issueDeviceToken(u, 'phone');
  assert.ok(dev.authenticateDeviceToken(token));
  const events = [];
  const a = id.loadOrCreateHostIdentity(db, { hostName: 'Desk', onEvent: (e) => events.push(e) });
  const b = id.loadOrCreateHostIdentity(db, { hostName: 'Desk' });
  assert.ok(a.created && !b.created);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^sha256:[A-Za-z0-9_-]{43}$/);
  const row = db.prepare('SELECT key_enc FROM host_api_identity').get();
  assert.ok(!row.key_enc.toString('latin1').includes('PRIVATE KEY'), 'key is not stored in the clear');
  db.prepare('UPDATE host_api_identity SET key_enc = ?').run(Buffer.alloc(40, 1)); // simulates a vault key change
  const c = id.loadOrCreateHostIdentity(db, { hostName: 'Desk', onEvent: (e) => events.push(e) });
  assert.notEqual(c.fingerprint, a.fingerprint);
  assert.deepEqual(events, ['identity_created', 'identity_reset', 'identity_created']);
  assert.equal(dev.authenticateDeviceToken(token), null, 'devices wiped with the identity');
});

test('an unexpected error propagates and leaves identity and devices intact', () => {
  const db = getDb();
  id.resetHostIdentity(db);
  id.loadOrCreateHostIdentity(db, { hostName: 'Desk' });
  const u = users.registerUser(db, { email: `id2-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'h' }).id;
  const { token } = dev.issueDeviceToken(u, 'phone');
  assert.throws(() => id.loadOrCreateHostIdentity(db, { hostName: 'Desk', deps: { decryptKey: () => { throw new TypeError('bug'); } } }), TypeError);
  assert.ok(dev.authenticateDeviceToken(token));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM host_api_identity').get().n, 1);
});

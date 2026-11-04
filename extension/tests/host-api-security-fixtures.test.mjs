import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(here, '_host-api-security-fixtures-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const vec = JSON.parse(fs.readFileSync(path.join(here, '../../schema/host-api/v1/fixtures/security/identity-vector.json'), 'utf8'));

test('vector fingerprint is sha256: + base64url(SHA-256(SPKI DER))', () => {
  const spki = Buffer.from(vec.spkiDerBase64, 'base64');
  assert.equal(vec.fingerprint, 'sha256:' + crypto.createHash('sha256').update(spki).digest('base64url'));
});

test('vector JWK private key exports the same SPKI', () => {
  const priv = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: vec.d, x: vec.x, y: vec.y }, format: 'jwk' });
  const spki = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
  assert.equal(spki.toString('base64'), vec.spkiDerBase64);
});

test('migration 0062 applies: scopes column and host_api_identity exist', () => {
  const db = kb.getDb();
  assert.ok(db.prepare('PRAGMA table_info(host_api_devices)').all().some((c) => c.name === 'scopes'));
  assert.ok(db.prepare('PRAGMA table_info(host_api_identity)').all().length >= 6);
});

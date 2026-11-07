// The desktop-only push routes (routes/host-api/http-routes.mjs): JWT user + bus host proof, then the listener flag.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-push-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();

const KEY_HEX = 'c3'.repeat(32);
const env = { LLMIDE_HOST_APPROVAL_KEY: KEY_HEX, LLMIDE_HOST_API_PUSH: '1' };
const PROOF = crypto.createHmac('sha256', Buffer.from(KEY_HEX, 'hex')).update('bus-host-proof/v1').digest('hex');
const PEM = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleHostApiRoute } = await import('../routes/host-api/http-routes.mjs');
const { createPushGate } = await import('../routes/host-api/push.mjs');

const state = { userId: users.registerUser(kb.getDb(), { email: `pr-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' }).id, enabled: true };
const audited = [];
const audit = () => ({ record: (event, f) => audited.push([event, f.userId, f.detail ?? null]) });
const server = http.createServer((req, res) => {
  req.user = { id: state.userId };
  void handleHostApiRoute(req, res, { hostApi: () => null, enabled: state.enabled, env, audit, pushDeps: { gate: createPushGate() } });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); wipe(); });
async function call(method, p, body, { proof = PROOF } = {}) {
  const r = await fetch(base + p, { method, headers: { ...(proof ? { 'x-llmide-host-nonce': proof } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const ROUTES = [['POST', '/host-api/push/send', { kind: 'loop_done' }], ['GET', '/host-api/push/status'], ['PUT', '/host-api/push/apns', {}], ['DELETE', '/host-api/push/apns']];

test('without the host proof every push route answers 403; with the flag off 404', async () => {
  for (const [m, p, b] of ROUTES) assert.equal((await call(m, p, b, { proof: null })).body.error.code, 'HOST_PROOF_REQUIRED', p);
  state.enabled = false;
  for (const [m, p, b] of ROUTES) assert.equal((await call(m, p, b)).body.error.code, 'HOST_API_DISABLED', p);
  state.enabled = true;
});

test('send validates the kind, key and count, then fans out (nothing registered: sent 0)', async () => {
  for (const b of [{ kind: 'core_down' }, { kind: 'loop_done', key: 'a b' }, { kind: 'loop_done', count: 0 }, { kind: 'loop_done', count: 1000 }]) {
    const r = await call('POST', '/host-api/push/send', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
  }
  assert.deepEqual(await call('POST', '/host-api/push/send', { kind: 'approval_chat', key: 'activity:1', count: 2 }), { status: 200, body: { sent: 0 } });
});

test('the APNs key: refused when invalid, saved, reported without the key, removed; audited without it', async () => {
  const bad = await call('PUT', '/host-api/push/apns', { key: 'x', keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'VALIDATION_FAILED']);
  assert.deepEqual(await call('PUT', '/host-api/push/apns', { key: PEM, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' }), { status: 200, body: { configured: true, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' } });
  const s = await call('GET', '/host-api/push/status');
  assert.deepEqual(s.body, { served: true, apns: { configured: true, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' }, devices: [] });
  assert.ok(!JSON.stringify(s.body).includes('PRIVATE KEY'));
  assert.deepEqual(await call('DELETE', '/host-api/push/apns'), { status: 200, body: { configured: false, keyId: null, teamId: null } });
  assert.deepEqual(audited.map(([e]) => e), ['push_apns_set', 'push_apns_removed']);
  assert.ok(!JSON.stringify(audited).includes('PRIVATE KEY'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
process.env.LLMIDE_HOST_APPROVAL_KEY = 'c'.repeat(64);
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const vault = await import('../server/vault.mjs');
const st = await import('../kb/sync-state.mjs');
const { handleSyncRoute, isSyncRoute } = await import('../routes/sync/http-routes.mjs');
const { recordCycleFailure } = await import('../routes/sync/scheduler.mjs');
const { busHostProof } = await import('../core/host-approval.mjs');
const PROOF = busHostProof();

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sr-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' }).id;
async function call(method, url, { userId, body, proof = true, deps } = {}) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, user: userId ? { id: userId } : undefined, headers: proof ? { 'x-llmide-host-nonce': PROOF } : {},
    socket: { remoteAddress: '127.0.0.1' }, pause() {}, resume() {},
    on(event, cb) { if (event === 'data') chunks.forEach((c) => cb(c)); else if (event === 'end') cb(); return req; } };
  let status = 0; let payload = '';
  const res = { headersSent: false, writeHead(s) { status = s; this.headersSent = true; }, setHeader() {}, end(b) { payload = b ?? ''; } };
  await handleSyncRoute(req, res, deps ? { deps } : {});
  return { status, body: payload ? JSON.parse(payload) : null };
}
const MEGA = { email: 'llmide-sync@example.com', password: 'a long dedicated password', folder: 'llmide-sync' };

test('routes need the bus host proof, then a user', async () => {
  assert.ok(isSyncRoute('/kb/sync/status'));
  assert.ok(!isSyncRoute('/kb/synchronize'));
  assert.equal((await call('GET', '/kb/sync/status', { userId: user(), proof: false })).status, 403);
  assert.equal((await call('GET', '/kb/sync/status', {})).status, 401);
});

test('MEGA setup validates, keeps the login only in the vault, and never returns it', async () => {
  const u = user();
  const bad = await call('POST', '/kb/sync/mega', { userId: u, body: { ...MEGA, email: 'not-an-email' } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details.field, 'email');
  const badFolder = await call('POST', '/kb/sync/mega', { userId: u, body: { ...MEGA, folder: '../up' } });
  assert.equal(badFolder.body.error.details.field, 'folder');
  const a = await call('POST', '/kb/sync/mega', { userId: u, body: { email: MEGA.email, password: MEGA.password } });
  assert.equal(a.status, 200);
  assert.equal(a.body.storeKind, 'mega');
  assert.deepEqual(a.body.store, { folder: 'llmide-sync', account: 'l***@example.com' }, 'the default folder name applies');
  assert.equal(a.body.enabled, false);
  const raw = JSON.stringify(a.body);
  assert.ok(!raw.includes(MEGA.password)); assert.ok(!raw.includes(MEGA.email));
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.megaPassword'), MEGA.password);
  assert.deepEqual(st.getSyncState(u).storeConfig, { folder: 'llmide-sync' }, 'the database holds the folder name only');
});

test('enable needs a configured store; status reflects it', async () => {
  const u = user();
  assert.equal((await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: true } })).status, 409);
  await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  const on = await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: true } });
  assert.equal(on.body.enabled, true);
  assert.equal((await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: 'yes' } })).status, 400);
});

test('test and publish surface coded store errors', async () => {
  const u = user();
  await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  const failing = { storeFor: () => ({ put: async () => { throw Object.assign(new Error('x'), { code: 'SYNC_MFA_REQUIRED' }); }, get: async () => null, remove: async () => {} }) };
  const r = await call('POST', '/kb/sync/test', { userId: u, deps: failing });
  assert.equal(r.status, 502); assert.equal(r.body.error.code, 'SYNC_MFA_REQUIRED');
});

test('a refused login turns sync off instead of retrying (no account lockout); rate limits back off', () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'mega', storeConfig: { folder: 'llmide-sync' } });
  st.setSyncEnabled(u, true);
  const backoff = new Map();
  const ms = recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_RATE_LIMITED' }), { now: 1000, backoff });
  assert.equal(ms, 60_000);
  assert.equal(st.getSyncState(u).enabled, true);
  assert.equal(st.getSyncState(u).lastError, 'SYNC_RATE_LIMITED');
  recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_AUTH_FAILED' }), { now: 2000, backoff });
  assert.equal(st.getSyncState(u).enabled, false);
  assert.equal(st.getSyncState(u).lastError, 'SYNC_AUTH_FAILED');
});

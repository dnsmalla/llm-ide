import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-state-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const vault = await import('../server/vault.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sync-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 's' }).id;

test('ensureSyncState mints one syncId and keeps it across store changes', () => {
  const u = user();
  assert.equal(st.getSyncState(u), null);
  const a = st.ensureSyncState(u, { storeKind: 'mega', storeConfig: { folder: 'llmide-sync' } });
  assert.match(a.syncId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(a.enabled, false);
  assert.equal(a.epoch, 1);
  const b = st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  assert.equal(b.syncId, a.syncId);
  assert.equal(b.storeKind, 'memory');
  st.setSyncEnabled(u, true);
  assert.ok(st.listEnabledSyncUsers().includes(u));
});

test('nextSeq is monotonic and at least the clock', () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  const a = st.nextSeq(u, 1000);
  const b = st.nextSeq(u, 500);
  const c = st.nextSeq(u, 5000);
  assert.deepEqual([a, b, c], [1000, 1001, 5000]);
});

test('devices, published entries and requests are per user', () => {
  const u = user(); const v = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.addSyncDevice(u, { deviceId: 'h1-a', dir: 'D'.repeat(22), tier: 'web', name: 'Phone', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([2]), now: 1 });
  assert.equal(st.listSyncDevices(u).length, 1);
  assert.equal(st.listSyncDevices(v).length, 0);
  st.setPublished(u, 'h1-a', 'chats', { file: 's/' + 'a'.repeat(32) + '.bin', seq: 5, fileSha256: 'f', plainSha256: 'p', epoch: 1 });
  assert.equal(st.getPublished(u, 'h1-a').chats.seq, 5);
  assert.deepEqual(st.getPublished(v, 'h1-a'), {});
  assert.equal(st.recordRequest(u, 'h1-a', 'R'.repeat(22), 10), true);
  assert.equal(st.recordRequest(u, 'h1-a', 'R'.repeat(22), 11), false, 'second record is a replay');
  assert.equal(st.countRequestsSince(u, 'h1-a', 0), 1);
  st.finishRequest(u, 'h1-a', 'R'.repeat(22), 'done');
});

test('sync vault keys are internal: storable by the server, not client-settable', () => {
  const u = user();
  vault.setSecret(kb.getDb(), u, 'sync.rootKey', 'x'.repeat(43));
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.rootKey'), 'x'.repeat(43));
  for (const k of ['sync.rootKey', 'sync.signingKey', 'sync.megaEmail', 'sync.megaPassword']) {
    assert.equal(vault.isUserSettableVaultKey(k), false);
    assert.ok(!vault.VAULT_KEYS.includes(k));
  }
});

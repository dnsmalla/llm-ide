// C6: Box is a Pattern A source with a stored connection. The scheduled run reads the vault, indexes at most once
// every 6 hours per user, and never spends a run on a missing connection.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-box-sched-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { setSecret, getSecret } = await import('../server/vault.mjs');
const { runSourcesUpdate, storedBoxConnection, BOX_SCHEDULED_MIN_INTERVAL_MS } = await import('../routes/bus/sources-update.mjs');

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const user = () => users.registerUser(kb.getDb(), { email: `box-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'CorrectHorseBattery', displayName: 'b' }).id;

function storeCreds(u) {
  const db = kb.getDb();
  setSecret(db, u, 'box.clientId', 'cid');
  setSecret(db, u, 'box.clientSecret', 'csecret');
  setSecret(db, u, 'box.subjectId', '12345');
  setSecret(db, u, 'box.folderId', '999');
}

test('the stored connection is read from the vault and a missing piece means none', () => {
  const u = user();
  assert.equal(storedBoxConnection(u), null);
  storeCreds(u);
  const c = storedBoxConnection(u);
  assert.equal(c.clientId, 'cid');
  assert.equal(c.subjectType, 'enterprise');
  assert.equal(c.folderId, '999');
});

test('no stored connection: box is not in the default set, and an explicit id is refused', async () => {
  const u = user();
  const out = await runSourcesUpdate({ userId: u, args: {} });
  assert.equal(out.results.some((r) => r.sourceId === 'box:default'), false);
  await assert.rejects(
    runSourcesUpdate({ userId: u, args: { sourceIds: ['box:default'] } }),
    (e) => e.code === 'not_found' && e.results[0].code === 'BOX_NOT_FOUND',
  );
});

test('a scheduled Box run indexes once and then skips until the interval elapses', async () => {
  const u = user();
  storeCreds(u);
  const calls = [];
  const index = async (_userId, creds) => { calls.push(creds.folderId); return { indexed: 7, files: 9, skipped: 0, truncated: false }; };
  const t0 = 1_800_000_000_000;
  const first = await runSourcesUpdate({ userId: u, args: { sourceIds: ['box:default'] }, now: t0, indexBox: index });
  assert.equal(first.synced, 1);
  assert.equal(first.results[0].count, 7);
  assert.equal(calls.length, 1);
  assert.equal(getSecret(kb.getDb(), u, 'box.lastIndexedAt'), String(t0));

  const soon = await runSourcesUpdate({ userId: u, args: { sourceIds: ['box:default'] }, now: t0 + BOX_SCHEDULED_MIN_INTERVAL_MS - 1, indexBox: index });
  assert.equal(soon.results[0].status, 'skipped');
  assert.equal(soon.results[0].code, 'BOX_TOO_SOON');
  assert.equal(calls.length, 1, 'no second index run');

  const later = await runSourcesUpdate({ userId: u, args: { sourceIds: ['box:default'] }, now: t0 + BOX_SCHEDULED_MIN_INTERVAL_MS, indexBox: index });
  assert.equal(later.synced, 1);
  assert.equal(calls.length, 2);
});

test('only unsupported ids is still invalid_args; overlapping runs do not double-walk', async () => {
  const u = user();
  await assert.rejects(
    runSourcesUpdate({ userId: u, args: { sourceIds: ['slack:x'] } }),
    (e) => e.code === 'invalid_args',
  );
  storeCreds(u);
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { calls.push(1); await gate; return { indexed: 1 }; };
  const t0 = 2_000_000_000_000;
  const first = runSourcesUpdate({ userId: u, args: { sourceIds: ['box:default'] }, now: t0, indexBox: slow });
  const second = await runSourcesUpdate({ userId: u, args: { sourceIds: ['box:default'] }, now: t0 + 1000, indexBox: slow });
  assert.equal(second.results[0].status, 'skipped', 'the in-flight claim makes the second run skip');
  release();
  const done = await first;
  assert.equal(done.synced, 1);
  assert.equal(calls.length, 1, 'one walk');
});

// The browser device against the real desktop sync code in this process over one memory store: the device contract,
// byte for byte, as shipped. Needs extension/node_modules; skipped with a reason otherwise. No network, no ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = new URL('../../../extension/', import.meta.url);
const skip = process.env.LLMIDE_E2E === '0' ? 'LLMIDE_E2E=0'
  : !existsSync(new URL('node_modules/better-sqlite3/package.json', EXT)) ? 'extension dependencies not installed' : false;

test('pair, read, queue and reply against the real desktop sync code', { skip }, async () => {
  const db = join(tmpdir(), `llmide-web-sync-e2e-${process.pid}.db`);
  Object.assign(process.env, { LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48), NODE_ENV: 'test', LLMIDE_LOG_FILE: 'none', LLMIDE_DB_PATH: db });
  const kb = await import('../../../extension/kb/db.mjs');
  const users = await import('../../../extension/server/users.mjs');
  const st = await import('../../../extension/kb/sync-state.mjs');
  const { createMemoryStore } = await import('../../../extension/connectors/sync-store/index.mjs');
  const { startEnrollment, pollEnrollment, confirmEnrollment } = await import('../../../extension/routes/sync/enroll.mjs');
  const { publishOnce } = await import('../../../extension/routes/sync/producer.mjs');
  const { drainOnce } = await import('../../../extension/routes/sync/consumer.mjs');
  const { parsePair } = await import('../../src/sync/enroll.ts');
  const D = await import('../../src/sync/device.ts');
  try {
    const T = Date.now();
    const u = users.registerUser(kb.getDb(), { email: `web-sync-e2e-${T}@example.com`, password: 'CorrectHorseBattery', displayName: 'w' }).id;
    st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
    st.setSyncEnabled(u, true);
    const store = createMemoryStore();
    const { qr } = await startEnrollment(u, { store, tier: 'web', now: T, env: {} });
    assert.ok(qr.startsWith('https://llm-ide.com/app/#pair='));
    const e = await D.startPairing(store, parsePair(qr), { name: 'E2E browser', now: T });
    const p = await pollEnrollment(u, { now: T + 1000 });
    assert.equal(p.phase, 'confirm');
    assert.equal(p.name, 'E2E browser');
    assert.equal(await D.readAck(store, e), p.sas, 'both screens show the same code');
    await confirmEnrollment(u, { now: T + 2000 });
    const d = await D.readFirstWrap(store, e, { megaEmail: 'sync@example.com' });
    assert.ok(d);
    assert.equal(d.epoch, st.getSyncState(u).epoch);
    const frames = () => Object.fromEntries(['chats', 'meetings', 'plans', 'usage'].map((k) => [k,
      Buffer.from(JSON.stringify({ v: 1, kind: k, generatedAt: T, truncated: false, items: k === 'usage' ? [{ providers: [] }] : [] }))]));
    await publishOnce({ userId: u, store, now: T + 3000, loadKinds: frames });
    const snap = await D.readSnapshot(store, d, T + 3000);
    assert.deepEqual(Object.keys(snap.kinds).sort(), ['chats', 'meetings', 'plans', 'usage']);
    const id = await D.sendRequest(store, d, 'hello from the browser', T + 4000);
    const deps = { phoneChatId: async () => 'phone-chat', cancel: () => {},
      turn: async (a) => { a.onEvent({ type: 'delta', text: 'hi browser' }); a.onEvent({ type: 'result' }); } };
    assert.equal((await drainOnce({ userId: u, store, now: T + 5000, deps })).ran, 1);
    assert.deepEqual(await D.readReply(store, d, id, T + 6000), { v: 1, requestId: id, ok: true, text: 'hi browser', finishedAt: T + 5000 });
  } finally {
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  }
});

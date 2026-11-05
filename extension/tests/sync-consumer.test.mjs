import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, createPublicKey } from 'node:crypto';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-consumer-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const S = await import('../core/sync-envelope.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { drainOnce, LIMITS } = await import('../routes/sync/consumer.mjs');
const { ensureSyncKeys } = await import('../routes/sync/keys.mjs');

let n = 0;
const NOW = 1_762_300_000_000;
function setup() {
  const u = users.registerUser(kb.getDb(), { email: `sc-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'c' }).id;
  const state = st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  const sig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dev = { deviceId: `h1-dev-${n}`, dir: randomBytes(16).toString('base64url'), tier: 'web', name: 'Phone',
    ecdhSpki: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }), signingSpki: sig.publicKey.export({ type: 'spki', format: 'der' }) };
  st.addSyncDevice(u, { ...dev, now: 1 });
  const keys = ensureSyncKeys(u);
  const dk = S.deviceKeys(keys.root, { userId: u, desktopId: state.syncId, deviceId: dev.deviceId }, keys.epoch);
  const store = createMemoryStore();
  const base = `${state.syncId}/d/${dev.dir}`;
  const send = async (body, { issuedAt = NOW, signer = sig.privateKey, requestId = randomBytes(16).toString('base64url'), epoch = keys.epoch } = {}) => {
    const env = S.seal({ header: { purpose: 'request', userId: u, desktopId: state.syncId, from: dev.deviceId, to: state.syncId, epoch, session: '', seq: 1, issuedAt, tier: '' },
      key: dk.request, plaintext: Buffer.from(JSON.stringify({ v: 1, requestId, class: 'chat.send', text: 'hello', ...body })), signingKey: signer });
    await store.put(`${base}/in/${issuedAt}-${requestId}.bin`, Buffer.from(JSON.stringify(env)));
    return requestId;
  };
  const reply = async (requestId) => {
    const bytes = await store.get(`${base}/out/${requestId}.bin`);
    return bytes && JSON.parse(S.open({ env: JSON.parse(bytes), key: dk.reply, verifyKey: createPublicKey(keys.signingKey), expect: { purpose: 'reply', to: dev.deviceId } }));
  };
  const calls = [];
  const deps = (events = [{ type: 'delta', text: 'hi there' }, { type: 'result' }]) => ({
    phoneChatId: async () => 'phone-chat',
    cancel: (userId, id) => calls.push(['cancel', id]),
    turn: async (args) => { calls.push(['turn', args.chatSessionId, args.message, Object.keys(args).sort().join(',')]); for (const e of events) args.onEvent(e); },
  });
  return { u, store, base, send, reply, calls, deps };
}

test('a valid queued prompt runs once through the turn dep and gets an encrypted reply', async () => {
  const t = setup();
  const id = await t.send({});
  assert.deepEqual(await drainOnce({ userId: t.u, store: t.store, now: NOW + 1000, deps: t.deps() }), { ran: 1, refused: 0, replied: 1 });
  assert.deepEqual(await t.reply(id), { v: 1, requestId: id, ok: true, text: 'hi there', finishedAt: NOW + 1000 });
  assert.deepEqual(t.calls[0], ['turn', 'phone-chat', 'hello', 'chatSessionId,message,onEvent,userId'], 'no mode or tool option reaches the turn');
  assert.deepEqual(await t.store.list(`${t.base}/in`), [], 'inbox file removed');
});

test('a replayed request id never runs twice', async () => {
  const t = setup();
  const id = await t.send({});
  await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps() });
  await t.send({}, { requestId: id });
  assert.deepEqual(await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps() }), { ran: 0, refused: 0, replied: 0 });
  assert.equal(t.calls.filter((c) => c[0] === 'turn').length, 1);
});

test('refusals: wrong signer, unknown field, wrong class, over-long text, oversize file', async () => {
  const t = setup();
  await t.send({}, { signer: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
  await t.send({ extra: 1 });
  await t.send({ class: 'files.write' });
  await t.send({ text: 'x'.repeat(LIMITS.maxText + 1) });
  await t.store.put(`${t.base}/in/${NOW}-${'Z'.repeat(22)}.bin`, Buffer.alloc(LIMITS.maxFileBytes + 1));
  const r = await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps() });
  assert.equal(r.ran, 0);
  assert.equal(r.refused, 5);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(await t.store.list(`${t.base}/in`), []);
});

test('age by the desktop clock: too old or too far ahead is expired, not run', async () => {
  const t = setup();
  const old = await t.send({}, { issuedAt: NOW - LIMITS.maxAgeMs - 1 });
  const ahead = await t.send({}, { issuedAt: NOW + LIMITS.maxSkewMs + 1 });
  await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps() });
  assert.equal((await t.reply(old)).code, 'expired');
  assert.equal((await t.reply(ahead)).code, 'expired');
  assert.equal(t.calls.length, 0);
});

test('an approval request is never answered remotely: cancel and reply needs_approval', async () => {
  const t = setup();
  const id = await t.send({});
  await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps([{ type: 'approval_request', requestId: 'a1', kind: 'ToolApproval' }, { type: 'error', message: 'cancelled' }]) });
  assert.equal((await t.reply(id)).code, 'needs_approval');
  assert.ok(t.calls.some((c) => c[0] === 'cancel'));
});

test('quota: at most perDrain per drain and perDay per device', async () => {
  const t = setup();
  for (let i = 0; i < LIMITS.perDrain + 2; i++) await t.send({}, { issuedAt: NOW + i });
  assert.equal((await drainOnce({ userId: t.u, store: t.store, now: NOW + 100, deps: t.deps() })).ran, LIMITS.perDrain);
  for (let i = 0; i < LIMITS.perDay; i++) st.recordRequest(t.u, `h1-dev-${n}`, `q${i}`.padEnd(22, 'q'), NOW);
  const id = await t.send({}, { issuedAt: NOW + 200 });
  await drainOnce({ userId: t.u, store: t.store, now: NOW + 300, deps: t.deps() });
  assert.equal((await t.reply(id)).code, 'quota');
});

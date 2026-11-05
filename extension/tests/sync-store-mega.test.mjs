// The MEGA adapter runs the SyncStore contract on a fake MEGA client (tests/helpers/fake-mega.mjs): no network in CI.
// A live run against a real THROWAWAY MEGA account is opt-in and manual:
//   LLMIDE_SYNC_MEGA_IT=1 LLMIDE_SYNC_MEGA_IT_EMAIL=... LLMIDE_SYNC_MEGA_IT_PASSWORD=... node --test tests/sync-store-mega.test.mjs
// Never point it at a personal account: it writes and deletes under the Cloud Drive folder "llmide-sync-it".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMegaStore, validateMegaConfig, maskEmail, classifyMegaError, DEFAULT_MEGA_FOLDER } from '../connectors/sync-store/mega.mjs';
import { createFakeMega } from './helpers/fake-mega.mjs';
import { runSyncStoreContract } from './helpers/sync-store-contract.mjs';

const CREDS = { email: 'llmide-sync@example.com', password: 'a long dedicated password' };
const CFG = { folder: DEFAULT_MEGA_FOLDER };
function make(fake = createFakeMega(CREDS)) {
  const sleeps = [];
  const store = createMegaStore(CFG, CREDS, { login: fake.login, sleep: async (ms) => { sleeps.push(ms); } });
  return { fake, store, sleeps };
}

runSyncStoreContract(test, assert, async () => make().store, 'mega (fake client)');

test('one login serves every operation; close logs out', async () => {
  const { fake, store } = make();
  await store.put('a/x.bin', Buffer.from('1'));
  await store.get('a/x.bin');
  await store.list('a');
  await store.remove('a/x.bin');
  assert.equal(fake.logins, 1);
  await store.close();
  assert.equal(fake.logouts, 1);
});

test('the sync folder is created once, at the Cloud Drive root, with the configured name', async () => {
  const fake = createFakeMega(CREDS);
  await make(fake).store.put('a.bin', Buffer.from('1'));
  await make(fake).store.put('b.bin', Buffer.from('2'));
  assert.deepEqual(fake.root.children.filter((c) => c.directory).map((d) => d.name), ['llmide-sync']);
  await createMegaStore({ folder: 'other-sync' }, CREDS, { login: fake.login }).put('c.bin', Buffer.from('3'));
  assert.deepEqual(fake.root.children.filter((c) => c.directory).map((d) => d.name).sort(), ['llmide-sync', 'other-sync']);
});

test('replace uploads exactly the given bytes, then deletes the old copy permanently', async () => {
  const { fake, store } = make();
  await store.put('d/manifest.bin', Buffer.from('old'));
  await store.put('d/manifest.bin', Buffer.from('new'));
  assert.deepEqual(fake.uploads.map((b) => b.toString()), ['old', 'new'], 'the adapter adds nothing to the bytes');
  assert.equal(fake.permanentDeletes, 1);
  fake.flush();
  const dir = fake.root.children[0].children.find((c) => c.name === 'd');
  assert.deepEqual(dir.children.map((c) => c.data.toString()), ['new']);
  assert.equal(Buffer.from(await store.get('d/manifest.bin')).toString(), 'new');
});

test('an expired session logs in again once; a lost keepalive session is replaced', async () => {
  const { fake, store } = make();
  await store.put('e/x.bin', Buffer.from('1'));
  fake.failNext('download', 'ESID (-15): Invalid or expired user session, please relogin');
  assert.equal(Buffer.from(await store.get('e/x.bin')).toString(), '1');
  assert.equal(fake.logins, 2);
  fake.loseSessions();
  await store.list('e');
  assert.equal(fake.logins, 3);
});

test('MEGA rate limits are retried twice (2 s, 8 s), then surface as SYNC_RATE_LIMITED', async () => {
  const { fake, store, sleeps } = make();
  fake.failNext('upload', 'ERATELIMIT (-4): You have exceeded your command weight per time quota.');
  await store.put('r/1.bin', Buffer.from('1'));
  assert.deepEqual(sleeps, [2000]);
  for (let i = 0; i < 3; i++) fake.failNext('download', 'EAGAIN (-3): A temporary congestion or server malfunction prevented your request from being processed.');
  await assert.rejects(() => store.get('r/1.bin'), (e) => e.code === 'SYNC_RATE_LIMITED');
  assert.deepEqual(sleeps, [2000, 2000, 8000]);
});

test('a wrong password and a two-factor account give codes that never carry the credentials', async () => {
  const fake = createFakeMega(CREDS);
  const wrong = createMegaStore(CFG, { ...CREDS, password: 'nope-nope' }, { login: fake.login });
  await assert.rejects(() => wrong.get('a.bin'), (e) => e.code === 'SYNC_AUTH_FAILED'
    && !e.message.includes('nope-nope') && !e.message.includes(CREDS.email));
  fake.failNext('login', 'EMFAREQUIRED (-26): Multi-Factor Authentication Required');
  const mfa = createMegaStore(CFG, CREDS, { login: fake.login });
  await assert.rejects(() => mfa.get('a.bin'), (e) => e.code === 'SYNC_MFA_REQUIRED');
});

test('classifyMegaError maps quota, network, login and unknown errors', () => {
  assert.equal(classifyMegaError(new Error('EOVERQUOTA (-17): Request over quota')), 'SYNC_QUOTA');
  assert.equal(classifyMegaError(new Error('MEGA returned a 509 status code')), 'SYNC_QUOTA');
  assert.equal(classifyMegaError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'SYNC_UNREACHABLE');
  assert.equal(classifyMegaError(new Error('ETEMPUNAVAIL (-18): Resource temporarily not available, please try again later')), 'SYNC_RATE_LIMITED');
  assert.equal(classifyMegaError(new Error('ENOENT (-9): Object (typically, node or user) not found. Wrong password?'), { duringLogin: true }), 'SYNC_AUTH_FAILED');
  assert.equal(classifyMegaError(new Error('ENOENT (-9): Object (typically, node or user) not found. Wrong password?')), 'SYNC_IO');
  assert.equal(classifyMegaError(new Error('something else')), 'SYNC_IO');
});

test('validateMegaConfig names the bad field; maskEmail hides the local part', () => {
  assert.equal(validateMegaConfig({ ...CREDS, folder: 'llmide-sync' }), null);
  assert.equal(validateMegaConfig({ ...CREDS, email: 'not-an-email', folder: 'x' }), 'email');
  assert.equal(validateMegaConfig({ ...CREDS, password: '', folder: 'x' }), 'password');
  assert.equal(validateMegaConfig({ ...CREDS, folder: '../up' }), 'folder');
  assert.equal(validateMegaConfig({ ...CREDS, folder: '..' }), 'folder');
  assert.equal(maskEmail('llmide-sync@example.com'), 'l***@example.com');
});

test('watch signals files added to its folder, survives a re-login, and stops', async () => {
  const { fake, store } = make();
  let hits = 0;
  const stop = store.watch('w/in', () => { hits++; });
  await store.put('w/in/1.bin', Buffer.from('1'));
  await store.put('w/other.bin', Buffer.from('2'));
  assert.equal(hits, 1);
  fake.loseSessions();
  await store.put('w/in/2.bin', Buffer.from('3'));
  assert.equal(hits, 2);
  stop();
  await store.put('w/in/3.bin', Buffer.from('4'));
  assert.equal(hits, 2);
});

const IT = process.env.LLMIDE_SYNC_MEGA_IT === '1';
test('live MEGA account (opt-in, throwaway account only)', { skip: !IT }, async () => {
  const s = createMegaStore({ folder: 'llmide-sync-it' },
    { email: process.env.LLMIDE_SYNC_MEGA_IT_EMAIL, password: process.env.LLMIDE_SYNC_MEGA_IT_PASSWORD });
  const dir = `probe-${Date.now()}`;
  try {
    await s.put(`${dir}/x.bin`, Buffer.from('one'));
    await s.put(`${dir}/x.bin`, Buffer.from('two'));
    assert.equal(Buffer.from(await s.get(`${dir}/x.bin`)).toString(), 'two');
    assert.deepEqual((await s.list(dir)).map((e) => e.name), ['x.bin']);
    await s.remove(`${dir}/x.bin`);
    assert.equal(await s.get(`${dir}/x.bin`), null);
  } finally {
    await s.removeTree(dir);
    await s.close();
  }
});

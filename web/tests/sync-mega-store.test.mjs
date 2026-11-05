// The browser's MEGA store on the shared fake MEGA client: login codes, newest-node reads, write-once puts that create
// only allowed folders, and interop with the SP1 desktop adapter on the same account. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createFakeMega } from '../../extension/tests/helpers/fake-mega.mjs';
import { openMegaStore, classifyMegaError } from '../src/sync/mega-store.ts';

const CREDS = { email: 'sync@example.com', password: 'Correct-Horse-Battery-77' };
const te = (s) => new TextEncoder().encode(s);
const td = (u) => new TextDecoder().decode(u);
const open = (fake, folder = 'llmide-sync') => openMegaStore({ ...CREDS, folder }, { login: fake.login });
const code = (c) => (e) => { assert.equal(e.code, c); return true; };
async function seed(fake, path, text) {
  let node = fake.root;
  for (const name of ['llmide-sync', ...path.split('/').slice(0, -1)]) node = node.children.find((c) => c.directory && c.name === name) ?? await node.mkdir(name);
  return node.upload({ name: path.split('/').at(-1), size: te(text).length }, Buffer.from(text)).complete;
}

test('login: wrong password and two-factor accounts are refused with codes; bad input never reaches MEGA', async () => {
  const fake = createFakeMega(CREDS);
  await assert.rejects(openMegaStore({ ...CREDS, password: 'nope', folder: 'llmide-sync' }, { login: fake.login }), code('SYNC_AUTH_FAILED'));
  fake.failNext('login', 'EMFAREQUIRED (-26): Multi-factor authentication required');
  await assert.rejects(open(fake), code('SYNC_MFA_REQUIRED'));
  const before = fake.logins;
  await assert.rejects(openMegaStore({ ...CREDS, email: 'not-an-email', folder: 'llmide-sync' }, { login: fake.login }), code('SYNC_BAD_EMAIL'));
  await assert.rejects(openMegaStore({ ...CREDS, password: '', folder: 'llmide-sync' }, { login: fake.login }), code('SYNC_BAD_PASSWORD'));
  await assert.rejects(openMegaStore({ ...CREDS, folder: '..' }, { login: fake.login }), code('SYNC_BAD_PATH'));
  assert.equal(fake.logins, before);
});

test('get: absent is null, the newest node of a name wins, a deleted node reads as absent', async () => {
  const fake = createFakeMega(CREDS);
  await seed(fake, 'S/d/D/manifest.bin', 'one');
  await seed(fake, 'S/d/D/manifest.bin', 'two');
  const s = await open(fake);
  assert.equal(td(await s.get('S/d/D/manifest.bin')), 'two');
  assert.equal(await s.get('S/d/D/none.bin'), null);
  assert.equal(await s.get('S/x/y.bin'), null);
  const gone = await seed(fake, 'S/d/D/out/R.bin', 'reply');
  await gone.delete(true);
  assert.equal(await s.get('S/d/D/out/R.bin'), null);
});

test('put: one upload per name, only the folders a device may create, never the sync or device folder', async () => {
  const fake = createFakeMega(CREDS);
  await seed(fake, 'S/d/D/key.bin', 'k');
  const s = await open(fake);
  await s.put('S/d/D/in/0000000000001-AAAAAAAAAAAAAAAAAAAAAA.bin', te('req'), 3);
  await s.put('S/d/D/in/0000000000001-AAAAAAAAAAAAAAAAAAAAAA.bin', te('req'), 3);
  assert.equal(fake.uploads.length, 2, 'key.bin + one request; the retry did not upload again');
  assert.equal(fake.uploads[1].toString(), 'req', 'the store adds nothing to the bytes');
  await s.put('S/e/SLOT/claim.bin', te('c'), 1);
  assert.equal(td(await s.get('S/e/SLOT/claim.bin')), 'c');
  await assert.rejects(s.put('S/d/OTHER/in/x.bin', te('x'), 3), code('SYNC_MISSING'));
  const sync = fake.root.children.find((c) => c.name === 'llmide-sync');
  assert.equal(sync.children.find((c) => c.name === 'S').children.find((c) => c.name === 'd').children.some((c) => c.name === 'OTHER'), false);
  const empty = createFakeMega(CREDS);
  await assert.rejects((await open(empty)).put('S/e/SLOT/c.bin', te('c'), 1), code('SYNC_MISSING'));
  assert.deepEqual(empty.root.children, [], 'the device never creates the sync folder');
});

test('paths are validated before any MEGA call', async () => {
  const s = await open(createFakeMega(CREDS));
  for (const p of ['../x', 'a//b', '', 'a/'.repeat(7) + 'b', 'a b']) {
    await assert.rejects(s.get(p), code('SYNC_BAD_PATH'), p);
    await assert.rejects(s.put(p, te('x'), 0), code('SYNC_BAD_PATH'), p);
  }
});

test('a lost or closed session is SYNC_SESSION_EXPIRED; rate limits and quota map to codes', async () => {
  const fake = createFakeMega(CREDS);
  await seed(fake, 'S/d/D/manifest.bin', 'm');
  const s = await open(fake);
  fake.failNext('download', 'ERATELIMIT (-4): Too many requests');
  await assert.rejects(s.get('S/d/D/manifest.bin'), code('SYNC_RATE_LIMITED'));
  fake.failNext('upload', 'EOVERQUOTA (-17): Over quota');
  await assert.rejects(s.put('S/d/D/in/1.bin', te('x'), 3), code('SYNC_QUOTA'));
  fake.loseSessions();
  await assert.rejects(s.get('S/d/D/manifest.bin'), code('SYNC_SESSION_EXPIRED'));
  const s2 = await open(fake);
  await s2.close();
  assert.equal(fake.logouts, 1);
  await assert.rejects(s2.get('S/d/D/manifest.bin'), code('SYNC_SESSION_EXPIRED'));
  assert.equal(classifyMegaError(new TypeError('Failed to fetch')), 'SYNC_UNREACHABLE');
  assert.equal(classifyMegaError(new Error('Load failed')), 'SYNC_UNREACHABLE');
});

const SP1 = existsSync(new URL('../../extension/node_modules/megajs/package.json', import.meta.url));
test('the SP1 desktop adapter and the browser store agree on the same account', { skip: SP1 ? false : 'extension/node_modules not installed' }, async () => {
  const { createMegaStore } = await import('../../extension/connectors/sync-store/mega.mjs');
  const fake = createFakeMega(CREDS);
  const desk = createMegaStore({ folder: 'llmide-sync' }, CREDS, { login: fake.login });
  await desk.put('S/d/D/key.bin', Buffer.from('k'));
  await desk.put('S/d/D/manifest.bin', Buffer.from('v1'));
  await desk.put('S/d/D/manifest.bin', Buffer.from('v2'));
  const s = await open(fake);
  assert.equal(td(await s.get('S/d/D/manifest.bin')), 'v2');
  await s.put('S/d/D/in/0000000000001-AAAAAAAAAAAAAAAAAAAAAA.bin', te('req'), 3);
  assert.deepEqual((await desk.list('S/d/D/in')).map((f) => f.name), ['0000000000001-AAAAAAAAAAAAAAAAAAAAAA.bin']);
  assert.equal((await desk.get('S/d/D/in/0000000000001-AAAAAAAAAAAAAAAAAAAAAA.bin')).toString(), 'req');
  await desk.close(); await s.close();
});

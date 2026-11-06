// The browser's Box store on the shared fake Box API (the same fake the desktop adapter's contract runs on): consent
// with state check, write-once puts that create only allowed folders, reads of the desktop's layout, one refresh on 401,
// rate limits as codes, revoke on close. No network. The desktop adapter is not imported (it pulls in better-sqlite3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBox } from '../../extension/tests/helpers/fake-box.mjs';
import { openBoxStore } from '../src/sync/box-store.ts';

const te = (s) => new TextEncoder().encode(s);
const td = (u) => new TextDecoder().decode(u);
const code = (c) => (e) => { assert.equal(e.code, c); return true; };
const consent = (fake, tamper = (q) => q) => ({
  closed: 0,
  async run(url) { const q = new URL(url).searchParams; return tamper(new URLSearchParams({ code: fake.issueCode(), state: q.get('state') })); },
  close() { this.closed += 1; },
});
const open = (fake, o = {}) => openBoxStore({ clientId: fake.clientId, clientSecret: fake.clientSecret, folder: 'llmide-sync' },
  { fetch: fake.fetch, authorize: consent(fake), origin: 'https://pwa.example', ...o });
test('reads the desktop layout (newest version, no bearer at the download host) and queues into in/', async () => {
  const fake = createFakeBox();
  fake.seed('llmide-sync/S/d/D/manifest.bin', 'm1');
  fake.seed('llmide-sync/S/d/D/manifest.bin', 'm2');
  const s = await open(fake);
  assert.equal(td(await s.get('S/d/D/manifest.bin')), 'm2');
  assert.equal(await s.get('S/d/D/none.bin'), null);
  await s.put('S/d/D/in/0000000000001-AAAAAAAAAAAAAAAAAAAAAA.bin', te('req'), 3);
  const inbox = fake.find('llmide-sync/S/d/D/in');
  assert.deepEqual(fake.children(inbox.id).map((x) => x.name), ['0000000000001-AAAAAAAAAAAAAAAAAAAAAA.bin']);
});

test('writes are write-once and never create the sync folder or folders below mkdirFrom', async () => {
  const fake = createFakeBox();
  const s0 = await open(fake);
  await assert.rejects(s0.put('S/e/X/c.bin', te('c'), 1), code('SYNC_MISSING'));
  fake.seed('llmide-sync/S/d/D/key.bin', 'k');
  const s = await open(fake);
  await s.put('S/e/X/c.bin', te('c'), 1);
  const before = fake.uploads.length;
  await s.put('S/e/X/c.bin', te('other'), 1);
  assert.equal(fake.uploads.length, before, 'a second put of the same name is a retry, not a replace');
  await assert.rejects(s.put('S/nope/in/x.bin', te('x'), 3), code('SYNC_MISSING'));
});

test('consent: a state mismatch and a cancel are refused; the popup is always closed', async () => {
  const fake = createFakeBox();
  const bad = consent(fake, (q) => { q.set('state', 'forged'); return q; });
  await assert.rejects(open(fake, { authorize: bad }), code('SYNC_AUTH_FAILED'));
  assert.equal(bad.closed, 1);
  const cancel = consent(fake, (q) => new URLSearchParams({ error: 'access_denied', state: q.get('state') }));
  await assert.rejects(open(fake, { authorize: cancel }), code('SYNC_AUTH_CANCELLED'));
  await assert.rejects(openBoxStore({ clientId: 'x', clientSecret: fake.clientSecret, folder: 'llmide-sync' }, { fetch: fake.fetch, authorize: consent(fake) }), code('SYNC_BAD_CLIENT'));
});

test('a 401 refreshes once; a refused refresh, a 429 and close() behave', async () => {
  const fake = createFakeBox();
  fake.seed('llmide-sync/S/x.bin', '1');
  const s = await open(fake);
  fake.expireAccess();
  assert.equal(td(await s.get('S/x.bin')), '1');
  fake.failNext('GET /2.0/folders/', 429, { headers: { 'retry-after': '30' } });
  await assert.rejects(s.get('S/x.bin'), code('SYNC_RATE_LIMITED'));
  await s.close();
  assert.equal(fake.revoked.length, 1, 'the refresh token is revoked on close');
  await assert.rejects(s.get('S/x.bin'), code('SYNC_SESSION_EXPIRED'));
  const s2 = await open(fake);
  fake.expireAccess(); fake.revokeRefresh();
  await assert.rejects(s2.get('S/x.bin'), code('SYNC_AUTH_FAILED'));
});

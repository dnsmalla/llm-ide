// The browser's Box store on the shared fake Box API (the same fake the desktop adapter's contract runs on): consent
// with state check, write-once puts that create only allowed folders, reads of the desktop's layout, one refresh on 401,
// rate limits as codes, revoke on close. No network. The desktop adapter is not imported (it pulls in better-sqlite3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBox } from '../../extension/tests/helpers/fake-box.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { callbackUrl, openBoxStore, popupAuthorize } from '../src/sync/box-store.ts';

const te = (s) => new TextEncoder().encode(s);
const td = (u) => new TextDecoder().decode(u);
const code = (c) => (e) => { assert.equal(e.code, c); return true; };
const consent = (fake, tamper = (q) => q) => ({
  closed: 0,
  async run(url) { const q = new URL(url).searchParams; return tamper(new URLSearchParams({ code: fake.issueCode(), state: q.get('state') })); },
  close() { this.closed += 1; },
});
const open = (fake, o = {}) => openBoxStore({ clientId: fake.clientId, clientSecret: fake.clientSecret, folder: 'llmide-sync' },
  { fetch: fake.fetch, authorize: consent(fake), baseURI: 'https://pwa.example/app/', ...o });
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

test('sign-in: SP7 authorize URL with the read-write scope and a redirect under the base path', async () => {
  const fake = createFakeBox();
  let seen = null;
  const spy = { run: async (url) => { seen = new URL(url); return new URLSearchParams({ code: fake.issueCode(), state: seen.searchParams.get('state') }); }, close() {} };
  await open(fake, { authorize: spy });
  assert.equal(seen.origin + seen.pathname, 'https://account.box.com/api/oauth2/authorize');
  assert.equal(seen.searchParams.get('scope'), 'root_readwrite');
  assert.equal(seen.searchParams.get('redirect_uri'), 'https://pwa.example/app/box-callback.html');
  assert.equal(seen.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(callbackUrl('http://127.0.0.1:5180/'), 'http://127.0.0.1:5180/box-callback.html');
});

test('every Box call omits cookies and has a timeout; a response that lands off the Box hosts is refused', async () => {
  const fake = createFakeBox();
  fake.seed('llmide-sync/S/x.bin', '1');
  const inits = [];
  let offHost = false;
  const f = async (url, init) => {
    inits.push(init);
    const r = await fake.fetch(url, init);
    if (offHost && String(url).includes('/content')) Object.defineProperty(r, 'url', { value: 'https://evil.example/x' });
    return r;
  };
  const s = await open(fake, { fetch: f });
  assert.equal(td(await s.get('S/x.bin')), '1');
  assert.ok(inits.every((i) => i.credentials === 'omit' && i.signal), 'credentials omit + timeout on every call');
  offHost = true;
  await assert.rejects(s.get('S/x.bin'), code('SYNC_IO'));
});

test('concurrent 401s share one refresh (Box refresh tokens are single use)', async () => {
  const fake = createFakeBox();
  fake.seed('llmide-sync/S/a.bin', 'a'); fake.seed('llmide-sync/S/b.bin', 'b');
  const s = await open(fake);
  fake.expireAccess();
  const before = fake.calls.filter((c) => c === 'POST api.box.com/oauth2/token').length;
  const [a, b] = await Promise.all([s.get('S/a.bin'), s.get('S/b.bin')]);
  assert.equal(td(a), 'a'); assert.equal(td(b), 'b');
  assert.equal(fake.calls.filter((c) => c === 'POST api.box.com/oauth2/token').length - before, 1, 'one refresh for both');
});

test('a refresh that lands after close() never brings the session back, and its new token is revoked', async () => {
  const fake = createFakeBox();
  fake.seed('llmide-sync/S/x.bin', '1');
  let hold = null; let held = null;
  const f = async (url, init) => {
    if (hold && String(url).endsWith('/oauth2/token')) { const r = await fake.fetch(url, init); held(); await hold; return r; }
    return fake.fetch(url, init);
  };
  const s = await open(fake, { fetch: f });
  fake.expireAccess();
  let release; hold = new Promise((r) => { release = r; });
  const reached = new Promise((r) => { held = r; });
  const pending = s.get('S/x.bin');
  await reached;
  await s.close();
  release();
  await assert.rejects(pending, code('SYNC_SESSION_EXPIRED'));
  await assert.rejects(s.get('S/x.bin'), code('SYNC_SESSION_EXPIRED'));
  assert.equal(fake.revoked.length, 2, 'the old refresh token on close, then the one the late refresh returned');
});

test('popupAuthorize: blocked, another tab\'s state ignored, a bad code refused, a closed popup cancels', async () => {
  const g = globalThis; const was = g.open;
  const chan = () => { const c = { onmessage: null, closed: false, close() { c.closed = true; } }; chans.push(c); return c; };
  const chans = [];
  const ticks = []; const every = (fn) => { ticks.push(fn); return () => {}; };
  const url = 'https://account.box.com/api/oauth2/authorize?state=w.mine';
  try {
    g.open = () => null;
    await assert.rejects(popupAuthorize({ channel: chan, every }).run(url), code('SYNC_POPUP_BLOCKED'));
    const popup = { closed: false, location: {}, close() { this.closed = true; } };
    g.open = () => popup;
    const ok = popupAuthorize({ channel: chan, every }).run(url);
    await new Promise((r) => setImmediate(r));
    chans.at(-1).onmessage({ data: { state: 'w.other', code: 'othercode123' } });
    chans.at(-1).onmessage({ data: { state: 'w.mine', code: 'goodcode123' } });
    const q = await ok;
    assert.equal(q.get('code'), 'goodcode123'); assert.equal(popup.location.href, url);
    const bad = popupAuthorize({ channel: chan, every }).run(url);
    await new Promise((r) => setImmediate(r));
    chans.at(-1).onmessage({ data: { state: 'w.mine', code: 'x' } });
    await assert.rejects(bad, code('SYNC_AUTH_FAILED'));
    const gone = popupAuthorize({ channel: chan, every }).run(url);
    await new Promise((r) => setImmediate(r));
    popup.closed = true; ticks.at(-1)();
    await assert.rejects(gone, code('SYNC_AUTH_CANCELLED'));
  } finally { g.open = was; }
});

test('box-callback.js strips the query, posts { state, code, error } on the shared channel, forwards an iPhone state', () => {
  const src = readFileSync(join(import.meta.dirname, '../public/box-callback.js'), 'utf8');
  const html = readFileSync(join(import.meta.dirname, '../public/box-callback.html'), 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'/);
  const run = (search) => {
    const posted = []; const replaced = []; const went = [];
    vm.runInNewContext(src, {
      URLSearchParams,
      location: { search, pathname: '/app/box-callback.html', replace: (u) => went.push(u) },
      history: { replaceState: (...a) => replaced.push(a) },
      BroadcastChannel: class { constructor(n) { this.n = n; } postMessage(m) { posted.push([this.n, m]); } close() {} },
      setTimeout: (fn) => fn(), window: { close() {} },
    });
    return { posted, replaced, went };
  };
  const w = run('?code=good-code-123&state=w.S1');
  assert.deepEqual(w.replaced[0], [null, '', '/app/box-callback.html']);
  assert.equal(w.posted[0][0], 'llmide-oauth');
  assert.deepEqual({ ...w.posted[0][1] }, { state: 'w.S1', code: 'good-code-123', error: null });
  const i = run('?code=c&state=i.S2');
  assert.deepEqual(i.went, ['llmide-box://oauth?code=c&state=i.S2']); assert.equal(i.posted.length, 0);
});

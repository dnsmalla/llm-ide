// The sources controller on the fake APIs: pop-up sign-in with PKCE (state checked, popup blocked/closed), tokens in
// memory only, one refresh in flight (Box refresh tokens are single use), browse/search/open, sign-out revokes,
// offline refusals, and app settings persisted without tokens. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSources, BOX_SECRET } from './helpers/fake-sources.mjs';
import { fakeIdb } from './helpers/fake-idb.mjs';
import { createSourcesController, TEXT } from '../src/sources/controller.ts';
import { indexedDbSourcesConfig, memorySourcesConfig } from '../src/sources/config.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const GL = { clientId: 'a'.repeat(64) };
const BOX = { clientId: 'b'.repeat(32), clientSecret: BOX_SECRET };

function harness(over = {}) {
  const fake = createFakeSources();
  const h = { fake, popups: [], channel: null, ticker: null, clock: 1_000_000, online: true };
  h.deps = {
    config: memorySourcesConfig(), fetchImpl: fake.fetchImpl, now: () => h.clock, sleep: async () => {},
    online: () => h.online, onNetwork: () => () => {},
    openPopup: () => { const w = { location: { href: '' }, closed: false, close() { this.closed = true; } }; h.popups.push(w); return w; },
    channel: () => (h.channel = { onmessage: null, close() {} }),
    every: (fn) => { h.ticker = fn; return () => { h.ticker = null; }; },
    baseURI: () => 'https://llm-ide.com/app/', random: (n) => new Uint8Array(n).fill(7),
    ...over,
  };
  h.c = createSourcesController(h.deps);
  return h;
}
async function signIn(h, p) {
  const done = h.c.signIn(p);
  for (let i = 0; i < 20 && !h.popups.at(-1)?.location.href; i++) await tick();
  const url = new URL(h.popups.at(-1).location.href);
  h.channel.onmessage({ data: { state: 'forged', code: 'evil-code-123' } });
  h.channel.onmessage({ data: { state: url.searchParams.get('state'), code: 'good-code-123' } });
  await done;
  return url;
}

test('GitLab: configure, sign in with PKCE in a pop-up, browse, page, open, search', async () => {
  const h = harness(); await h.c.start();
  assert.equal(await h.c.configure('gitlab', GL), true);
  const url = await signIn(h, 'gitlab');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://llm-ide.com/app/oauth-callback.html');
  assert.equal(url.searchParams.get('scope'), 'read_api read_repository');
  assert.equal(h.popups[0].closed, true);
  const tok = h.fake.calls.find((k) => k.url === 'https://gitlab.com/oauth/token');
  assert.equal(tok.form.code, 'good-code-123'); assert.match(tok.form.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(h.c.getState().signedIn.gitlab, true);
  await h.c.choose('gitlab');
  assert.deepEqual(h.c.getState().entries.map((e) => e.name), ['demo', 'empty']);
  await h.c.openEntry(h.c.getState().entries[0]);
  assert.deepEqual(h.c.getState().trail.map((e) => e.name), ['demo']);
  assert.equal(h.c.getState().next, '2');
  await h.c.more();
  assert.equal(h.c.getState().entries.length, 5);
  await h.c.openEntry(h.c.getState().entries.find((e) => e.name === 'README.md'));
  assert.equal(h.c.getState().opened.kind, 'markdown');
  h.c.closeFile();
  await h.c.search('x');
  assert.equal(h.c.getState().query, 'x');
  assert.deepEqual(h.c.getState().entries.map((e) => e.path), ['src/app.ts']);
  await h.c.clearSearch();
  await h.c.toCrumb(-1);
  assert.deepEqual(h.c.getState().trail, []);
  assert.equal(h.c.getState().entries[0].kind, 'project');
});

test('pop-up blocked, closed pop-up, offline, and an unconfigured provider are refused with sentences', async () => {
  const blocked = harness({ openPopup: () => null }); await blocked.c.start(); await blocked.c.configure('gitlab', GL);
  await blocked.c.signIn('gitlab');
  assert.equal(blocked.c.getState().error, TEXT.popup_blocked);
  const h = harness(); await h.c.start(); await h.c.configure('gitlab', GL);
  const p = h.c.signIn('gitlab');
  for (let i = 0; i < 20 && !h.popups[0].location.href; i++) await tick();
  h.popups[0].closed = true; h.ticker();
  await p;
  assert.equal(h.c.getState().error, TEXT.sign_in_cancelled);
  assert.equal(h.c.getState().signedIn.gitlab, false);
  h.online = false;
  await h.c.signIn('gitlab');
  assert.equal(h.c.getState().error, TEXT.offline);
  await h.c.signIn('box');
  assert.equal(h.c.getState().error, TEXT.not_configured);
});

test('a token response with a write scope is refused and nothing is kept', async () => {
  const h = harness(); await h.c.start(); await h.c.configure('gitlab', GL);
  h.fake.queue('https://gitlab.com/oauth/token', () => h.fake.json({ access_token: 'acc-12345678', refresh_token: 'r', expires_in: 7200, scope: 'api' }));
  await signIn(h, 'gitlab');
  assert.equal(h.c.getState().error, TEXT.scope_too_wide);
  assert.equal(h.c.getState().signedIn.gitlab, false);
});

test('Box: expired token refreshes once for parallel calls (single-use refresh), a refused refresh signs out', async () => {
  const h = harness(); await h.c.start(); await h.c.configure('box', BOX);
  await signIn(h, 'box');
  assert.equal(h.fake.calls.find((k) => k.url === 'https://api.box.com/oauth2/token').form.client_secret, BOX_SECRET);
  await h.c.choose('box');
  h.clock += 2 * 3600_000; // past expiry
  await Promise.all([h.c.choose('box'), h.c.openEntry({ id: '11', name: 'Specs', kind: 'dir', path: 'Specs', size: null, detail: null, project: null })]);
  const refreshes = h.fake.calls.filter((k) => k.url === 'https://api.box.com/oauth2/token' && k.form?.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(h.c.getState().signedIn.box, true);
  h.clock += 2 * 3600_000;
  h.fake.queue('https://api.box.com/oauth2/token', () => h.fake.json({ error: 'invalid_grant' }, 400));
  await h.c.choose('box');
  assert.equal(h.c.getState().error, TEXT.signed_out);
  assert.equal(h.c.getState().signedIn.box, false);
});

test('sign out revokes the token, forgets it in memory, and leaves the browser view', async () => {
  const h = harness(); await h.c.start(); await h.c.configure('gitlab', GL);
  await signIn(h, 'gitlab'); await h.c.choose('gitlab');
  await h.c.signOut('gitlab');
  const rv = h.fake.calls.find((k) => k.url === 'https://gitlab.com/oauth/revoke');
  assert.equal(rv.form.token, 'gitlab-access-2');
  assert.equal(h.c.getState().signedIn.gitlab, false);
  assert.equal(h.c.getState().provider, null);
});

test('app settings persist in IndexedDB without tokens; bad stored rows are ignored', async () => {
  const idb = fakeIdb();
  const h = harness({ config: indexedDbSourcesConfig(idb) }); await h.c.start();
  await h.c.configure('gitlab', GL); await h.c.configure('box', BOX);
  await signIn(h, 'gitlab');
  const stored = JSON.stringify([...idb.data.values()]);
  assert.match(stored, new RegExp(GL.clientId));
  assert.doesNotMatch(stored, /access|refresh|verifier/);
  idb.data.set('config', { v: 1, gitlab: { clientId: 'x' }, box: BOX });
  const again = harness({ config: indexedDbSourcesConfig(idb) }); await again.c.start();
  assert.deepEqual(again.c.getState().configured, { gitlab: false, box: true });
  assert.equal(again.c.getState().signedIn.gitlab, false, 'a reload means signing in again (decision D4)');
});

test('bad search input and offline browsing are explained', async () => {
  const h = harness(); await h.c.start(); await h.c.configure('gitlab', GL); await signIn(h, 'gitlab');
  await h.c.choose('gitlab');
  await h.c.search('   ');
  assert.equal(h.c.getState().error, TEXT.bad_query);
  h.online = false;
  await h.c.toCrumb(-1);
  assert.equal(h.c.getState().error, TEXT.offline);
});

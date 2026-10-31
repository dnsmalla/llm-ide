// HTTP layer of the extensions catalog (P4): status codes, validation, per-user
// isolation. The install route reaches GitHub through the pinned fetch, which a
// test replaces with fixtures (NODE_ENV=test seam), so nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { repoArchive, withCompare } from './helpers/tar-fixture.mjs';

process.env.NODE_ENV = 'test';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-routes-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(root, 'plugins');
process.env.LLMIDE_EXT_ALLOWED_SOURCES = '*/*'; // fixtures install from made-up owners
const { isExtensionRoute, handleExtensionRoute } = await import('../routes/extension-routes.mjs');
const { isAuthRoute } = await import('../server/auth-routes.mjs');
const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');

const SHA = 'e'.repeat(40);
const SKILL = '---\nname: Tidy\n---\nTidy up.\n';
const PLUGIN = { '.claude-plugin/plugin.json': '{"name":"runner"}', 'hooks/hooks.json': '{"hooks":{"Stop":[]}}' };
const archives = new Map([
  [`https://codeload.github.com/acme/tidy/tar.gz/${SHA}`, repoArchive({ 'SKILL.md': SKILL })],
  [`https://codeload.github.com/acme/runner/tar.gz/${SHA}`, repoArchive(PLUGIN)],
]);
_setPinnedFetchForTests(withCompare(async (url) => {
  const hit = archives.get(String(url));
  return hit ? new Response(hit, { status: 200 }) : new Response('nope', { status: 404 });
}));

function call(method, url, body, user = { id: 'u1' }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: {}, user, socket: { remoteAddress: '127.0.0.1' } });
  return new Promise((resolve) => {
    const res = { statusCode: 0, _b: '', headersSent: false, writableEnded: false,
      writeHead(c) { this.statusCode = c; this.headersSent = true; }, setHeader() {}, getHeader() {},
      end(b) { this._b += b || ''; this.writableEnded = true; resolve({ status: this.statusCode, body: this._b ? JSON.parse(this._b) : null }); } };
    handleExtensionRoute(req, res, { db: null, logger: null, requestId: 'r' });
  });
}

test('the catalog paths belong to the extension dispatcher only', () => {
  for (const p of ['/auth/me/extensions/installed', '/auth/me/extensions/install', '/auth/me/extensions/toggle?x=1', '/auth/me/extensions/uninstall']) {
    assert.equal(isExtensionRoute(p), true, p);
    assert.equal(isAuthRoute(p), false, p);
  }
  assert.equal(isExtensionRoute('/auth/me/extensions/other'), false);
});

test('signed-out requests get 401', async () => {
  const r = await call('GET', '/auth/me/extensions/installed', undefined, null);
  assert.equal(r.status, 401);
});

test('install, list, enable, disable, uninstall over HTTP', async () => {
  const bad = await call('POST', '/auth/me/extensions/install', { url: 'https://evil.com/a/b' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_URL');

  const ins = await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/tidy', commit: SHA });
  assert.equal(ins.status, 200);
  assert.equal(ins.body.item.id, 'skill:acme/tidy');
  assert.equal(ins.body.item.state.enabled, false);
  assert.equal(ins.body.item.pinnedCommit, SHA);

  const list = await call('GET', '/auth/me/extensions/installed');
  assert.deepEqual(list.body.items.map((i) => i.id), ['skill:acme/tidy']);
  assert.deepEqual((await call('GET', '/auth/me/extensions/installed', undefined, { id: 'u2' })).body.items, [], 'another user sees nothing');

  assert.equal((await call('POST', '/auth/me/extensions/toggle', { id: 'skill:acme/tidy', enabled: 'yes' })).status, 400);
  const on = await call('POST', '/auth/me/extensions/toggle', { id: 'skill:acme/tidy', enabled: true });
  assert.equal(on.body.item.state.enabled, true);
  assert.equal((await call('POST', '/auth/me/extensions/toggle', { id: 'skill:acme/tidy', enabled: true }, { id: 'u2' })).status, 404, 'u2 has not installed it');
  assert.equal((await call('POST', '/auth/me/extensions/toggle', { id: 'skill:acme/tidy', enabled: false })).body.item.state.enabled, false);

  assert.equal((await call('POST', '/auth/me/extensions/uninstall', { id: 'skill:acme/tidy' })).status, 200);
  assert.equal((await call('POST', '/auth/me/extensions/uninstall', { id: 'skill:acme/tidy' })).status, 404);
  assert.equal((await call('POST', '/auth/me/extensions/uninstall', { id: '../../etc' })).status, 404);
});

test('an item with executable parts needs consent per kind (409 names them)', async () => {
  const ins = await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/runner', commit: SHA });
  assert.equal(ins.status, 200);
  const id = ins.body.item.id;
  const no = await call('POST', '/auth/me/extensions/toggle', { id, enabled: true });
  assert.equal(no.status, 409);
  assert.equal(no.body.error.code, 'CONSENT_REQUIRED');
  assert.deepEqual(no.body.error.details.kinds, ['hook']);
  const yes = await call('POST', '/auth/me/extensions/toggle', { id, enabled: true, consents: ['hook'] });
  assert.equal(yes.status, 200);
  assert.equal(yes.body.item.state.enabled, true);
});

test('wrong method, bad body and a marketplace repo get precise errors', async () => {
  assert.equal((await call('GET', '/auth/me/extensions/install')).status, 405);
  assert.equal((await call('POST', '/auth/me/extensions/installed', {})).status, 405);
  assert.equal((await call('POST', '/auth/me/extensions/install', [])).status, 400);
  const gone = await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/none', commit: SHA });
  assert.equal(gone.status, 404);
  process.env.LLMIDE_EXT_CATALOG = 'off';
  const off = await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/tidy', commit: SHA }, { id: 'u9' });
  delete process.env.LLMIDE_EXT_CATALOG;
  assert.equal(off.body.error.code, 'CATALOG_DISABLED');
});

// ---- P5: updates, rollback, repair, indexes, search, active -----------------

const SHA2 = 'f'.repeat(40);
const SKILL2 = '---\nname: Tidy\n---\nTidy harder.\n';
const heads = new Map();
const registryBody = JSON.stringify({ servers: [{ server: { name: 'io.github.acme/notes', description: 'Notes', repository: { url: 'https://github.com/acme/notes' } } }] });
_setPinnedFetchForTests(withCompare(async (url) => {
  const u = String(url);
  if (heads.has(u)) return new Response(heads.get(u), { status: 200 });
  if (u.startsWith('https://registry.modelcontextprotocol.io/')) return new Response(registryBody, { status: 200 });
  const hit = archives.get(u);
  return hit ? new Response(hit, { status: 200 }) : new Response('nope', { status: 404 });
}));

test('P5 routes belong to the extension dispatcher; reads are GET, steps are POST', async () => {
  for (const p of ['catalog?q=x', 'catalog/refresh', 'active', 'updates', 'updates/check', 'update/preview', 'update', 'rollback', 'repair']) {
    assert.equal(isExtensionRoute(`/auth/me/extensions/${p}`), true, p);
  }
  assert.equal((await call('POST', '/auth/me/extensions/catalog', {})).status, 405);
  assert.equal((await call('GET', '/auth/me/extensions/update')).status, 405);
  assert.equal((await call('GET', '/auth/me/extensions/repair')).status, 405);
  for (const p of ['catalog', 'active', 'updates', 'update', 'rollback']) assert.equal((await call('GET', `/auth/me/extensions/${p}`, undefined, null)).status, 401, p);
});

test('update flow over HTTP: check, preview, apply (consent), rollback, repair; per user', async () => {
  const ins = await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/tidy', commit: SHA }, { id: 'p1' });
  const id = ins.body.item.id;
  archives.set(`https://codeload.github.com/acme/tidy/tar.gz/${SHA2}`, repoArchive({ 'SKILL.md': SKILL2 }));
  heads.set('https://api.github.com/repos/acme/tidy/commits/HEAD', SHA2);

  assert.deepEqual((await call('GET', '/auth/me/extensions/updates', undefined, { id: 'p1' })).body.items, [], 'a GET never goes to the network');
  const chk = await call('POST', '/auth/me/extensions/updates/check', {}, { id: 'p1' });
  assert.equal(chk.status, 200);
  assert.deepEqual(chk.body.results.map((r) => [r.id, r.updateAvailable, r.latest]), [[id, true, SHA2]]);
  assert.equal((await call('GET', '/auth/me/extensions/updates', undefined, { id: 'p1' })).body.items[0].latest, SHA2);
  assert.deepEqual((await call('GET', '/auth/me/extensions/updates', undefined, { id: 'p2' })).body.items, []);
  assert.equal((await call('POST', '/auth/me/extensions/updates/check', { id: '../x' }, { id: 'p1' })).status, 404);

  const pv = await call('POST', '/auth/me/extensions/update/preview', { id }, { id: 'p1' });
  assert.equal(pv.status, 200);
  assert.deepEqual([pv.body.from, pv.body.to, pv.body.files.counts], [SHA, SHA2, { added: 0, removed: 0, changed: 1 }]);
  assert.equal((await call('POST', '/auth/me/extensions/update/preview', { id: 'skill:nobody/x' }, { id: 'p1' })).status, 404);
  assert.equal((await call('POST', '/auth/me/extensions/update/preview', { id, commit: 5 }, { id: 'p1' })).status, 400);
  assert.equal((await call('POST', '/auth/me/extensions/update/preview', { id }, { id: 'p2' })).status, 404, 'p2 has not installed it');

  assert.equal((await call('POST', '/auth/me/extensions/update', { id, consents: 'hook' }, { id: 'p1' })).status, 400);
  const ap = await call('POST', '/auth/me/extensions/update', { id }, { id: 'p1' });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.item.pinnedCommit, SHA2);
  assert.equal(ap.body.item.previous.pinnedCommit, SHA);
  assert.equal(ap.body.update.enabled, false);
  assert.equal((await call('POST', '/auth/me/extensions/update', { id, commit: SHA2 }, { id: 'p1' })).body.error.code, 'ALREADY_CURRENT');

  const rb = await call('POST', '/auth/me/extensions/rollback', { id }, { id: 'p1' });
  assert.equal(rb.body.item.pinnedCommit, SHA);
  assert.equal((await call('POST', '/auth/me/extensions/rollback', { id }, { id: 'p2' })).status, 404);

  const rp = await call('POST', '/auth/me/extensions/repair', { id }, { id: 'p1' });
  assert.deepEqual([rp.status, rp.body.status], [200, 'ok']);
  // a reinstall at another commit says where to go
  const re = await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/tidy', commit: SHA2 }, { id: 'p1' });
  assert.equal(re.status, 409);
  assert.equal(re.body.error.details.use, '/auth/me/extensions/update');
});

test('rollback with nothing to go back to, and a missing archive, get precise errors', async () => {
  await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/tidy', commit: SHA }, { id: 'p3' });
  const no = await call('POST', '/auth/me/extensions/rollback', { id: 'skill:acme/tidy' }, { id: 'p3' });
  assert.deepEqual([no.status, no.body.error.code], [404, 'NO_PREVIOUS']);
  const gone = await call('POST', '/auth/me/extensions/update', { id: 'skill:acme/tidy', commit: 'a'.repeat(40) }, { id: 'p3' });
  assert.deepEqual([gone.status, gone.body.error.code], [404, 'NOT_FOUND']);
  const bad = await call('POST', '/auth/me/extensions/update', { id: 'skill:acme/tidy', commit: 'nope' }, { id: 'p3' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'INVALID_COMMIT']);
});

test('catalog: refresh is a POST, search is a cache-only GET, bad kind is 400, unknown source 404', async () => {
  const empty = await call('GET', '/auth/me/extensions/catalog?q=notes');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.total, 0);
  assert.equal(empty.body.sources.length, 4);
  assert.equal((await call('GET', '/auth/me/extensions/catalog?kind=bogus')).status, 400);
  assert.equal((await call('POST', '/auth/me/extensions/catalog/refresh', { source: 'evil.example' })).status, 404);
  assert.equal((await call('POST', '/auth/me/extensions/catalog/refresh', { source: 7 })).status, 400);
  const r = await call('POST', '/auth/me/extensions/catalog/refresh', { source: 'mcp-registry', force: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => [x.id, x.status]), [['mcp-registry', 'refreshed']]);
  const hit = await call('GET', '/auth/me/extensions/catalog?q=notes&kind=mcp&limit=5');
  assert.deepEqual(hit.body.results.map((e) => [e.name, e.installable, e.reason]), [['io.github.acme/notes', false, 'registry_install_not_supported']]);
  // another source fails (404 on GitHub) without breaking the response
  const all = await call('POST', '/auth/me/extensions/catalog/refresh', {});
  assert.equal(all.status, 200);
  assert.equal(all.body.results.length, 4);
  process.env.LLMIDE_EXT_CATALOG = 'off';
  const off = await call('POST', '/auth/me/extensions/catalog/refresh', {});
  delete process.env.LLMIDE_EXT_CATALOG;
  assert.equal(off.body.error.code, 'CATALOG_DISABLED');
});

test('active: names and counts only, per user, no configs and no paths', async () => {
  await call('POST', '/auth/me/extensions/install', { url: 'https://github.com/acme/tidy', commit: SHA }, { id: 'p4' });
  const r = await call('GET', '/auth/me/extensions/active', undefined, { id: 'p4' });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.fingerprint, 'string');
  assert.ok(Array.isArray(r.body.mcpServers) && Array.isArray(r.body.items) && Array.isArray(r.body.skills));
  assert.equal(typeof r.body.sdkPlugins, 'number');
  assert.ok(!JSON.stringify(r.body).includes(root), 'no file system path leaks');
});

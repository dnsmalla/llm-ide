// HTTP layer of the extensions catalog (P4): status codes, validation, per-user
// isolation. The install route reaches GitHub through the pinned fetch, which a
// test replaces with fixtures (NODE_ENV=test seam), so nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { repoArchive } from './helpers/tar-fixture.mjs';

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
_setPinnedFetchForTests(async (url) => {
  const hit = archives.get(String(url));
  return hit ? new Response(hit, { status: 200 }) : new Response('nope', { status: 404 });
});

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

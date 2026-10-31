// HTTP layer of workspace trust and the per-user allowlist: status codes, validation, isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_workspace-trust-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
process.env.LLMIDE_PLUGIN_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-routes-')), 'plugins');
delete process.env.LLMIDE_EXT_ALLOWED_SOURCES_CEILING;
const { isExtensionRoute, handleExtensionRoute } = await import('../routes/extension-routes.mjs');
const { isAuthRoute } = await import('../server/auth-routes.mjs');
const main = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const mk = (e) => users.registerUser(main.getDb(), { email: e, password: 'CorrectHorseBattery', displayName: e }).id;
const U1 = mk('wtr-1@example.test');
const U2 = mk('wtr-2@example.test');
const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-routes-folder-')));
test.after(() => { main.closeDb(); for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true }); });

function call(method, url, body, user = { id: U1 }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: {}, user, socket: { remoteAddress: '127.0.0.1' } });
  return new Promise((resolve) => {
    const res = { statusCode: 0, _b: '', headersSent: false, writableEnded: false,
      writeHead(c) { this.statusCode = c; this.headersSent = true; }, setHeader() {}, getHeader() {},
      end(b) { this._b += b || ''; this.writableEnded = true; resolve({ status: this.statusCode, body: this._b ? JSON.parse(this._b) : null }); } };
    handleExtensionRoute(req, res, { db: null, logger: null, requestId: 'r' });
  });
}

test('the new paths belong to the extension dispatcher only', () => {
  for (const p of ['/auth/me/workspace-trust', '/auth/me/workspace-trust?x=1', '/auth/me/extensions/allowlist']) {
    assert.equal(isExtensionRoute(p), true, p);
    assert.equal(isAuthRoute(p), false, p);
  }
});

test('signed-out requests get 401', async () => {
  assert.equal((await call('GET', '/auth/me/workspace-trust', undefined, null)).status, 401);
  assert.equal((await call('GET', '/auth/me/extensions/allowlist', undefined, null)).status, 401);
});

test('workspace trust: empty list, explicit trust, revoke, per-user isolation', async () => {
  const empty = await call('GET', '/auth/me/workspace-trust');
  assert.deepEqual(empty.body, { enforced: true, items: [] });
  const set = await call('PUT', '/auth/me/workspace-trust', { path: folder, trusted: true });
  assert.equal(set.status, 200);
  assert.equal(set.body.ok, true);
  assert.equal(set.body.item.path, folder);
  assert.equal(set.body.item.trusted, true);
  assert.equal((await call('GET', '/auth/me/workspace-trust')).body.items.length, 1);
  assert.deepEqual((await call('GET', '/auth/me/workspace-trust', undefined, { id: U2 })).body.items, []);
  const off = await call('PUT', '/auth/me/workspace-trust', { path: folder, trusted: false });
  assert.equal(off.body.item.trusted, false);
});

test('workspace trust: a symlink is stored as its real path', async () => {
  const link = path.join(path.dirname(folder), `link-${path.basename(folder)}`);
  fs.symlinkSync(folder, link);
  const r = await call('PUT', '/auth/me/workspace-trust', { path: link, trusted: true }, { id: U2 });
  assert.equal(r.body.item.path, folder);
  fs.rmSync(link);
});

test('workspace trust: validation and errors', async () => {
  const cases = [
    [{ path: folder }, 400, 'VALIDATION_FAILED'],
    [{ trusted: true }, 400, 'VALIDATION_FAILED'],
    [{ path: 'relative/dir', trusted: true }, 400, 'VALIDATION_FAILED'],
    [{ path: folder, trusted: 'yes' }, 400, 'VALIDATION_FAILED'],
    [{ path: path.join(folder, 'missing'), trusted: true }, 404, 'NOT_FOUND'],
    [{ path: '/', trusted: true }, 400, 'INVALID_PATH'],
    [{ path: os.homedir(), trusted: true }, 400, 'INVALID_PATH'],
  ];
  for (const [body, status, code] of cases) {
    const r = await call('PUT', '/auth/me/workspace-trust', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.body.error.code, code, JSON.stringify(body));
  }
  assert.equal((await call('POST', '/auth/me/workspace-trust', {})).status, 405);
});

test('workspace trust: kill switch reports enforced false', async () => {
  process.env.LLMIDE_WORKSPACE_TRUST = 'off';
  try { assert.equal((await call('GET', '/auth/me/workspace-trust')).body.enforced, false); }
  finally { delete process.env.LLMIDE_WORKSPACE_TRUST; }
});

test('allowlist: get, put, merge, per-user isolation', async () => {
  const g = await call('GET', '/auth/me/extensions/allowlist');
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, { operator: ['anthropics/*', 'modelcontextprotocol/*'], ceiling: null, user: [], ignored: [], effective: ['anthropics/*', 'modelcontextprotocol/*'] });
  const p = await call('PUT', '/auth/me/extensions/allowlist', { sources: ['Acme/Tools', 'acme/tools', 'foo/*'] });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.user, ['acme/tools', 'foo/*']);
  assert.deepEqual(p.body.effective, ['anthropics/*', 'modelcontextprotocol/*', 'acme/tools', 'foo/*']);
  assert.deepEqual((await call('GET', '/auth/me/extensions/allowlist', undefined, { id: U2 })).body.user, []);
});

test('allowlist: errors', async () => {
  const cases = [
    [{ sources: ['*/*'] }, 403, 'SOURCE_EXCEEDS_CEILING'],
    [{ sources: ['ac*/x'] }, 403, 'SOURCE_EXCEEDS_CEILING'],
    [{ sources: ['not a repo'] }, 400, 'INVALID_SOURCE'],
    [{ sources: [5] }, 400, 'INVALID_SOURCE'],
    [{ sources: Array.from({ length: 51 }, (_, i) => `o${i}/r`) }, 400, 'TOO_MANY_SOURCES'],
    [{ sources: 'acme/x' }, 400, 'VALIDATION_FAILED'],
    [{}, 400, 'VALIDATION_FAILED'],
  ];
  for (const [body, status, code] of cases) {
    const r = await call('PUT', '/auth/me/extensions/allowlist', body);
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
    assert.equal(r.body.error.code, code);
  }
  assert.equal((await call('POST', '/auth/me/extensions/allowlist', {})).status, 405);
  // a failed PUT leaves the saved list alone
  assert.deepEqual((await call('GET', '/auth/me/extensions/allowlist')).body.user, ['acme/tools', 'foo/*']);
});

test('allowlist: the operator ceiling is honoured over HTTP', async () => {
  process.env.LLMIDE_EXT_ALLOWED_SOURCES_CEILING = 'acme/*';
  try {
    assert.equal((await call('PUT', '/auth/me/extensions/allowlist', { sources: ['acme/x'] })).status, 200);
    const r = await call('PUT', '/auth/me/extensions/allowlist', { sources: ['evil/x'] });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body.error.details, { entry: 'evil/x' });
    const g = await call('GET', '/auth/me/extensions/allowlist');
    assert.deepEqual(g.body.ceiling, ['acme/*']);
  } finally { delete process.env.LLMIDE_EXT_ALLOWED_SOURCES_CEILING; }
});

test('install honours a user addition and nothing else', async () => {
  const { repoArchive } = await import('./helpers/tar-fixture.mjs');
  const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');
  const SHA = 'c'.repeat(40);
  _setPinnedFetchForTests(async (url) => String(url) === `https://codeload.github.com/zoo/tidy/tar.gz/${SHA}`
    ? new Response(repoArchive({ 'SKILL.md': '---\nname: Tidy\n---\nTidy up.\n' }), { status: 200 }) : new Response('nope', { status: 404 }));
  const body = { url: 'https://github.com/zoo/tidy', commit: SHA };
  const refused = await call('POST', '/auth/me/extensions/install', body);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'SOURCE_NOT_ALLOWED');
  await call('PUT', '/auth/me/extensions/allowlist', { sources: ['zoo/tidy'] });
  assert.equal((await call('POST', '/auth/me/extensions/install', body)).status, 200);
  const other = await call('POST', '/auth/me/extensions/install', body, { id: U2 });
  assert.equal(other.status, 403, 'another user did not add it');
});

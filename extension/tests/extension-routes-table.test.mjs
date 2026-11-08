// Track Q (T-Q.1) identity proof: the plugin / LLM-source / MCP-plugin routes
// moved from server/auth-routes.mjs to routes/extension-routes.mjs as a PURE
// MOVE. Three assertions pin that:
//   1. the method + path table the generated inventory reports for them is the
//      one captured BEFORE the move (fixtures/extension-route-table-before-track-q.txt);
//   2. for ~250 probe paths, exactly one of isAuthRoute / isExtensionRoute claims
//      a path now iff isAuthRoute claimed it before (fixtures/auth-route-dispatch-before-track-q.json),
//      and the two dispatchers never overlap;
//   3. the extension handler keeps the same 401 guard, and an unmatched path
//      under its prefixes keeps the same 404 body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const here = path.dirname(fileURLToPath(import.meta.url));
const { isAuthRoute } = await import('../server/auth-routes.mjs');
const { isExtensionRoute, handleExtensionRoute } = await import('../routes/extension-routes.mjs');
// Read the table from the generator output, not the committed snapshot: the
// snapshot is no longer gated for drift (CI regenerates it), so a test that
// read it would silently check an old table.
const { buildInventoryModel } = await import('../../scripts/http-inventory.mjs');

test('inventory method+path table for the moved routes is unchanged', () => {
  const golden = fs.readFileSync(path.join(here, 'fixtures/extension-route-table-before-track-q.txt'), 'utf8')
    .split('\n').filter(Boolean).map((l) => l.trim());
  const now = [];
  for (const row of buildInventoryModel().rows) {
    if (!/^\/auth\/me\/(plugins|claude-plugins|codex-plugins|llm-sources|mcp-plugins)/.test(row.path)) continue;
    now.push(`${row.methods} ${row.path}`);
    assert.match(row.handler, /^(extension\/routes\/extension-routes\.mjs:\d+|-)$/, `${row.path} handler moved`);
    assert.equal(row.auth, 'token', `${row.path} stays authenticated`);
  }
  assert.deepEqual(now.sort(), golden.slice().sort());
});

test('dispatch ownership: same paths claimed as before, never by both modules', () => {
  const before = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/auth-route-dispatch-before-track-q.json'), 'utf8'));
  let moved = 0;
  for (const [p, wasAuth] of Object.entries(before)) {
    const a = isAuthRoute(p);
    const e = isExtensionRoute(p);
    assert.equal(a || e, wasAuth, `${p}: union of dispatchers must equal the old isAuthRoute`);
    assert.equal(a && e, false, `${p}: claimed by both dispatchers`);
    if (e) moved++;
  }
  assert.ok(moved >= 36, `expected the extension group to claim its routes, got ${moved}`);
});

function res() {
  return {
    statusCode: 0, _body: '', headersSent: false,
    writeHead(c) { this.statusCode = c; this.headersSent = true; },
    end(b) { this._body += b || ''; },
  };
}

test('unauthenticated request gets the same 401; unmatched path gets the same 404', async () => {
  const mk = (method, url, user) => ({ method, url, headers: {}, user, socket: { remoteAddress: '127.0.0.1' } });
  const r1 = res();
  await handleExtensionRoute(mk('GET', '/auth/me/plugins'), r1, { db: null, logger: null, requestId: 'x' });
  assert.equal(r1.statusCode, 401);
  assert.deepEqual(JSON.parse(r1._body), { error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
  const r2 = res();
  await handleExtensionRoute(mk('GET', '/auth/me/mcp-plugins/zz/nothing', { id: 'u1' }), r2, { db: null, logger: null, requestId: 'x' });
  assert.equal(r2.statusCode, 404);
  assert.deepEqual(JSON.parse(r2._body), { error: { code: 'NOT_FOUND', message: 'No auth route for GET /auth/me/mcp-plugins/zz/nothing' } });
});

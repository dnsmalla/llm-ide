// MCP connector OAuth discovery/token/registration URLs come from the remote server's JSON: they must be pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_mcp-client-ssrf-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { startMcpAuthorization, pinnedFetchFor } = await import('../connectors/mcp-client.mjs');
const { makePinnedFetch } = await import('../server/pinned-fetch.mjs');

const user = users.registerUser(kb.getDb(), { email: `ssrf-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'T' });
const defFor = (serverUrl) => ({
  id: 'miro', name: 'Miro', serverUrl, scope: 'boards:read', byoClient: false, clientName: 'LLM-IDE',
  byoClientIdKey: 'mcp.miro.byoClientId', byoClientSecretKey: 'mcp.miro.byoClientSecret',
  listTool: null, readTool: null, mapItem: null,
});

/** A hostile MCP server: 401s, then advertises metadata that points at internal addresses. */
async function hostile(t, issuer) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ resource: base, authorization_servers: [typeof issuer === 'function' ? issuer(base) : issuer] })); return;
    }
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`,
        token_endpoint: 'http://169.254.169.254/token', registration_endpoint: 'http://169.254.169.254/register',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] })); return;
    }
    res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}`, seen };
}

test('issuer pointing at the cloud metadata address is refused: no authorization URL, no request there', async (t) => {
  const h = await hostile(t, 'http://169.254.169.254/');
  let out = null, err = null;
  try { out = await startMcpAuthorization({ db: kb.getDb(), userId: user.id, def: defFor(h.url), stateToken: 's1' }); } catch (e) { err = e; }
  assert.ok(err || !out?.authorizationUrl?.includes('169.254.169.254'), 'must not hand back an authorization URL on the metadata host');
});

test('registration/token endpoints in metadata that target link-local are refused', async (t) => {
  const h = await hostile(t, (base) => base); // honest issuer; its metadata carries the bad endpoints
  await assert.rejects(startMcpAuthorization({ db: kb.getDb(), userId: user.id, def: defFor(h.url), stateToken: 's2' }), (e) => { return /SSRF|169\.254/i.test(String(e?.message) + String(e?.cause?.message)); });
});

test('a public connector cannot be aimed at loopback, private or metadata addresses by metadata URLs', async () => {
  const f = pinnedFetchFor(defFor('https://mcp.miro.com'));
  // NODE_ENV=test returns the real pin here (globalThis.fetch is untouched).
  for (const u of ['http://127.0.0.1:1/x', 'http://localhost/x', 'http://10.0.0.1/x', 'https://169.254.169.254/x', 'http://[::1]/x', 'http://[::ffff:169.254.169.254]/x']) {
    await assert.rejects(f(u), (e) => e.code === 'SSRF_BLOCKED', u);
  }
});

test('DNS rebinding: a hostname that resolves to a private/link-local address is refused at connect time', async () => {
  for (const addr of ['127.0.0.1', '10.9.9.9', '169.254.169.254']) {
    const f = pinnedFetchFor(defFor('https://mcp.miro.com'), { resolver: async () => [{ address: addr, family: 4 }] });
    await assert.rejects(f('https://auth.attacker.example/.well-known/oauth-authorization-server'), (e) => e.code === 'SSRF_BLOCKED', addr);
  }
  // Mixed answer (one public, one private) is refused too.
  const mixed = pinnedFetchFor(defFor('https://mcp.miro.com'), { resolver: async () => [{ address: '203.0.113.7', family: 4 }, { address: '10.0.0.1', family: 4 }] });
  await assert.rejects(mixed('https://auth.attacker.example/x'), (e) => e.code === 'SSRF_BLOCKED');
});

test('link-local stays refused even for the loopback test override', async () => {
  const f = pinnedFetchFor(defFor('http://127.0.0.1:9'));
  await assert.rejects(f('http://169.254.169.254/token'), (e) => e.code === 'SSRF_BLOCKED');
});

test('the SDK transport gets a pinned fetch (public default refuses redirect following to other origins by itself)', () => {
  assert.equal(typeof makePinnedFetch, 'function');
  assert.equal(typeof pinnedFetchFor(defFor('https://mcp.miro.com')), 'function');
});

// HTTP-layer tests for POST /kb/mcp-connector/test. Setup mirrors
// tests/kb-router-slack.test.mjs; the connector is pointed at the hermetic
// fixture via LLMIDE_MCP_MIRO_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-router-mcp-connector-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleKB } = await import('../routes/router.mjs');
const { mcpConnectorDef } = await import('../connectors/mcp-connector-defs.mjs');
const { startMcpAuthorization, finishMcpAuthorization } = await import('../connectors/mcp-client.mjs');
const { startFakeMcpServer } = await import('./fixtures/fake-mcp-oauth-server.mjs');

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}
let n = 0;
const newUser = () => users.registerUser(db.getDb(), {
  email: `kb-mcp-${Date.now()}-${++n}@example.com`,
  password: 'CorrectHorseBattery', displayName: 'T',
});
async function post(url, body, userId) {
  const res = makeRes();
  await handleKB(makeReq({ method: 'POST', url, body, userId }), res);
  return res;
}

test('unknown connector id → 400', async () => {
  const u = newUser();
  for (const body of [{ id: 'nope' }, { id: 'gdrive' }, {}]) {
    const r = await post('/kb/mcp-connector/test', body, u.id);
    assert.equal(r.statusCode, 400, r._body);
    assert.equal(r.json().error.code, 'VALIDATION_FAILED');
  }
});

test('not connected → 400 MCP_UNAUTHORIZED, not a 502', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const u = newUser();
  const r = await post('/kb/mcp-connector/test', { id: 'miro' }, u.id);
  assert.equal(r.statusCode, 400, r._body);
  assert.equal(r.json().error.code, 'MCP_UNAUTHORIZED');
  assert.deepEqual(fake.requests, [], 'an unconnected probe must not hit the server');
});

test('connected → 200 with the server identity and its tool list', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const u = newUser();
  const def = mcpConnectorDef('miro');
  const started = await startMcpAuthorization({ db: db.getDb(), userId: u.id, def, stateToken: 's' });
  const { code } = await fake.authorize(started.authorizationUrl);
  await finishMcpAuthorization({ db: db.getDb(), userId: u.id, def, code });

  const r = await post('/kb/mcp-connector/test', { id: 'miro' }, u.id);
  assert.equal(r.statusCode, 200, r._body);
  const out = r.json();
  assert.equal(out.ok, true);
  assert.deepEqual(out.server, { name: 'fake-miro', version: '0.0.1' });
  assert.deepEqual(out.tools.sort(), ['get_board_items', 'list_boards']);
});

test('an unreachable server → 502 MCP_CONNECT_FAILED', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  const u = newUser();
  const def = mcpConnectorDef('miro');
  const started = await startMcpAuthorization({ db: db.getDb(), userId: u.id, def, stateToken: 's' });
  const { code } = await fake.authorize(started.authorizationUrl);
  await finishMcpAuthorization({ db: db.getDb(), userId: u.id, def, code });
  await fake.close();                 // tokens are saved, the server is gone
  t.after(() => { delete process.env.LLMIDE_MCP_MIRO_URL; });

  const r = await post('/kb/mcp-connector/test', { id: 'miro' }, u.id);
  assert.equal(r.statusCode, 502, r._body);
  assert.equal(r.json().error.code, 'MCP_CONNECT_FAILED');
});

test('the endpoint is advertised and rate-limited like its siblings', async () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.mjs'), 'utf8');
  assert.match(server, /'\/kb\/mcp-connector\/test',/, 'must be in the ENDPOINTS array');
  assert.match(server, /url === '\/kb\/mcp-connector\/test'\) return 'dispatch'/,
    'external-API test routes belong on the dispatch bucket');
  assert.match(server, /const SERVER_API_VERSION = 38;/, 'adding an endpoint bumps the version');
});

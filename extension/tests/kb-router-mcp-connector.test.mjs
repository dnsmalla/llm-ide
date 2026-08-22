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
  assert.match(server, /url === '\/kb\/mcp-connector\/test' \|\| /,
    'external-API test routes belong on the dispatch bucket');
});

// ── Phase 2b: fetch / seen / classify ──────────────────────────────────────

const BOARD_TOOLS = [
  { name: 'list_boards', handler: () => ({ data: [{ id: 'b1', name: 'Alpha' }] }) },
  {
    name: 'get_board_items',
    handler: (args) => ({ data: [
      { id: 'i1', type: 'sticky_note', data: { content: `<p>${args.board_id} one</p>` }, modifiedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'i2', type: 'text', text: 'two', modifiedAt: '2026-08-02T00:00:00.000Z' },
    ] }),
  },
];

/** Connected user pointed at a live fixture. */
async function connectedUser(t, tools = BOARD_TOOLS) {
  const fake = await startFakeMcpServer({ tools });
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });
  const u = newUser();
  const def = mcpConnectorDef('miro');
  const started = await startMcpAuthorization({ db: db.getDb(), userId: u.id, def, stateToken: 's' });
  const { code } = await fake.authorize(started.authorizationUrl);
  await finishMcpAuthorization({ db: db.getDb(), userId: u.id, def, code });
  return { u, fake };
}

test('fetch returns mapped items and seen suppresses them on the next call', async (t) => {
  const { u } = await connectedUser(t);

  const r1 = await post('/kb/mcp-connector/fetch', { id: 'miro' }, u.id);
  assert.equal(r1.statusCode, 200, r1._body);
  const out = r1.json();
  assert.equal(out.items.length, 2);
  assert.equal(out.drained, true);
  assert.equal(out.skipped.overCap, 0);
  assert.deepEqual(out.failures, []);
  // Exactly the shape the Mac adapter decodes.
  for (const i of out.items) {
    assert.equal(typeof i.id, 'string');
    assert.equal(typeof i.body, 'string');
    assert.equal(typeof i.fields.Board, 'string');
  }

  const ack = await post('/kb/mcp-connector/seen',
    { id: 'miro', itemIds: out.items.map((i) => i.id) }, u.id);
  assert.equal(ack.statusCode, 200, ack._body);
  assert.equal(ack.json().marked, 2);

  const r2 = await post('/kb/mcp-connector/fetch', { id: 'miro' }, u.id);
  assert.deepEqual(r2.json().items, []);
});

test('the seen ledger is per user', async (t) => {
  const { u } = await connectedUser(t);
  const first = await post('/kb/mcp-connector/fetch', { id: 'miro' }, u.id);
  await post('/kb/mcp-connector/seen',
    { id: 'miro', itemIds: first.json().items.map((i) => i.id) }, u.id);

  const other = newUser();
  const r = await post('/kb/mcp-connector/seen', { id: 'miro', itemIds: ['x'] }, other.id);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().marked, 1, "another user's marks are their own");
});

test('every action rejects an unknown connector id the same way', async () => {
  const u = newUser();
  for (const action of ['test', 'fetch', 'seen']) {
    for (const body of [{ id: 'nope' }, { id: 'gdrive' }, {}]) {
      const r = await post(`/kb/mcp-connector/${action}`, body, u.id);
      assert.equal(r.statusCode, 400, `${action} ${JSON.stringify(body)}: ${r._body}`);
      assert.equal(r.json().error.code, 'VALIDATION_FAILED');
    }
  }
});

test('fetch without a connection is 400 MCP_UNAUTHORIZED and touches nothing', async (t) => {
  const fake = await startFakeMcpServer({ tools: BOARD_TOOLS });
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const r = await post('/kb/mcp-connector/fetch', { id: 'miro' }, newUser().id);
  assert.equal(r.statusCode, 400, r._body);
  assert.equal(r.json().error.code, 'MCP_UNAUTHORIZED');
  assert.deepEqual(fake.requests, []);
});

test('a failing board surfaces as a 200 with failures, not a 502', async (t) => {
  // Partial success is success: the healthy boards imported, and turning the
  // whole request into an error would discard them.
  const { u } = await connectedUser(t, [
    { name: 'list_boards', handler: () => ({ data: [{ id: 'ok', name: 'Fine' }, { id: 'bad', name: 'Locked' }] }) },
    { name: 'get_board_items', handler: (a) => {
      if (a.board_id === 'bad') throw new Error('board is private');
      return { data: [{ id: 'i1', text: 'kept' }] };
    } },
  ]);
  const r = await post('/kb/mcp-connector/fetch', { id: 'miro' }, u.id);
  assert.equal(r.statusCode, 200, r._body);
  assert.equal(r.json().items.length, 1);
  assert.equal(r.json().failures.length, 1);
  assert.equal(r.json().drained, false);
});

test('an unreachable server during fetch is 502 MCP_FETCH_FAILED', async (t) => {
  const { u, fake } = await connectedUser(t);
  await fake.close();                        // tokens saved, server gone
  const r = await post('/kb/mcp-connector/fetch', { id: 'miro' }, u.id);
  assert.equal(r.statusCode, 502, r._body);
  assert.equal(r.json().error.code, 'MCP_FETCH_FAILED');
});

test('test still answers the phase-2a shape, plus toolSchemas', async (t) => {
  const { u } = await connectedUser(t);
  const r = await post('/kb/mcp-connector/test', { id: 'miro' }, u.id);
  assert.equal(r.statusCode, 200, r._body);
  assert.equal(r.json().ok, true);
  assert.deepEqual(r.json().tools.sort(), ['get_board_items', 'list_boards']);
  assert.ok(Array.isArray(r.json().toolSchemas));
});

test('classify accepts the manifest engine envelope and rejects a bad one', async () => {
  const u = newUser();
  const bad = await post('/kb/mcp-connector/classify', { notBody: 1 }, u.id);
  assert.equal(bad.statusCode, 400, bad._body);
  assert.equal(bad.json().error.code, 'VALIDATION_FAILED');

  const empty = await post('/kb/mcp-connector/classify', { body: { connectorId: 'miro', text: '' } }, u.id);
  assert.equal(empty.statusCode, 400, 'an empty item is a client bug, not an LLM call');
});

test('the three endpoints are advertised, versioned and bucketed', async () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.mjs'), 'utf8');
  for (const p of ['/kb/mcp-connector/fetch', '/kb/mcp-connector/seen', '/kb/mcp-connector/classify']) {
    assert.ok(server.includes(`'${p}',`), `${p} must be in the ENDPOINTS array`);
  }
  assert.match(server, /const SERVER_API_VERSION = 39;/, 'three new endpoints bump the version');
  assert.match(server, /url === '\/kb\/mcp-connector\/fetch'\) return 'dispatch'/);
  assert.match(server, /url === '\/kb\/mcp-connector\/seen'\) return 'kbWrite'/);
  assert.match(server, /url === '\/kb\/mcp-connector\/classify'\) return 'llm'/);
});

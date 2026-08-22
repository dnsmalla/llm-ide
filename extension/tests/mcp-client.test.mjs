// Tests for extension/connectors/mcp-client.mjs against the hermetic
// fixture. DB + vault bootstrap follows tests/kb-router-slack.test.mjs.
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
const tmpDb = path.join(__dirname, '_mcp-client-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { getSecret, setSecret } = await import('../server/vault.mjs');
const {
  VaultOAuthProvider, mcpRedirectUri, startMcpAuthorization, finishMcpAuthorization,
  isMcpConnected, withMcpSession, testMcpConnection,
  parseToolResult, chunkText, fetchMcpItems, markMcpSeen, MAX_ITEM_CHARS,
} = await import('../connectors/mcp-client.mjs');
const { defaultMcpItemMapper } = await import('../connectors/mcp-connector-defs.mjs');
const { startFakeMcpServer } = await import('./fixtures/fake-mcp-oauth-server.mjs');

let userCounter = 0;
function newUser() {
  return users.registerUser(kb.getDb(), {
    email: `mcp-client-${Date.now()}-${++userCounter}@example.com`,
    password: 'CorrectHorseBattery', displayName: 'T',
  });
}
const defFor = (fake, over = {}) => ({
  id: 'miro', name: 'Miro', serverUrl: fake.url, scope: 'boards:read',
  byoClient: false, clientName: 'LLM-IDE',
  byoClientIdKey: 'mcp.miro.byoClientId',
  byoClientSecretKey: 'mcp.miro.byoClientSecret',
  listTool: null, readTool: null, mapItem: null, ...over,
});

/** Drive the whole connect dance for `user` against `fake`. */
async function connectFully(db, user, def, fake) {
  const state = 'state-token-1';
  const started = await startMcpAuthorization({ db, userId: user.id, def, stateToken: state });
  const { code } = await fake.authorize(started.authorizationUrl);
  return finishMcpAuthorization({ db, userId: user.id, def, code });
}

test('redirect URI is the callback route on the configured port', () => {
  assert.equal(mcpRedirectUri(), 'http://127.0.0.1:3456/auth/mcp-connector/callback');
});

test('start captures an authorization URL instead of redirecting', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);

  const r = await startMcpAuthorization({ db, userId: user.id, def, stateToken: 'st-1' });
  assert.equal(r.alreadyConnected, false);

  const url = new URL(r.authorizationUrl);
  assert.equal(url.origin, fake.origin);
  assert.equal(url.pathname, '/authorize');
  assert.equal(url.searchParams.get('state'), 'st-1', 'our state token, so the callback can find the user');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), mcpRedirectUri());

  // Dynamic client registration happened, advertising OUR callback.
  assert.equal(fake.registrations.length, 1);
  assert.deepEqual(fake.registrations[0].redirect_uris, [mcpRedirectUri()]);
  assert.equal(fake.registrations[0].client_name, 'LLM-IDE');
});

test('finish exchanges the code on a fresh transport and persists tokens', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);

  assert.equal(isMcpConnected(db, user.id, def), false);
  const { account } = await connectFully(db, user, def, fake);
  assert.equal(account, 'fake-miro', 'the server identity, read back over a verified session');
  assert.equal(isMcpConnected(db, user.id, def), true);

  // The PKCE verifier survived a round trip through the encrypted vault —
  // the fixture rejects the exchange otherwise.
  assert.equal(fake.tokenRequests.at(-1).grant_type, 'authorization_code');
  assert.ok(fake.tokenRequests.at(-1).code_verifier);
});

test('credentials are stored issuer-scoped under vault-legal keys', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  assert.equal(getSecret(db, user.id, 'mcp.miro.issuer'), `${fake.origin}/`);

  const p = new VaultOAuthProvider({ db, userId: user.id, def });
  for (const field of ['tokens', 'clientInformation', 'codeVerifier']) {
    const key = p.key(field);
    assert.match(key, /^mcp\.miro-[0-9a-f]{12}\.[a-zA-Z]+$/, key);
    // server/vault.mjs MCP_CREDENTIAL_KEY_RE must accept it — getSecret
    // throws "Unknown vault key" otherwise.
    assert.doesNotThrow(() => getSecret(db, user.id, key));
  }
  assert.ok(getSecret(db, user.id, p.key('tokens')));
});

test('a session with saved tokens makes no OAuth requests', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  fake.clearLog();
  const result = await testMcpConnection(db, user.id, def);
  assert.deepEqual(result.server, { name: 'fake-miro', version: '0.0.1' });
  assert.deepEqual(result.tools.sort(), ['get_board_items', 'list_boards']);
  assert.ok(fake.requests.every((r) => r.endsWith(' /mcp')),
    `expected /mcp only, saw ${fake.requests.join(', ')}`);
});

test('an unconnected user gets MCP_UNAUTHORIZED without touching the network', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);

  await assert.rejects(
    () => withMcpSession(db, user.id, def, async () => 'never'),
    (e) => {
      assert.equal(e.code, 'MCP_UNAUTHORIZED');
      assert.match(e.message, /Miro/);
      return true;
    },
  );
  // No speculative DCR: an ingestion sweep for an unconnected user must be
  // free, not a fresh client registration every tick.
  assert.deepEqual(fake.requests, []);
});

test('selections are per user — one user connecting does not connect another', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const def = defFor(fake);
  const a = newUser();
  const b = newUser();
  await connectFully(db, a, def, fake);
  assert.equal(isMcpConnected(db, a.id, def), true);
  assert.equal(isMcpConnected(db, b.id, def), false);
});

test('start returns alreadyConnected when tokens are still good', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  const again = await startMcpAuthorization({ db, userId: user.id, def, stateToken: 'st-2' });
  assert.equal(again.alreadyConnected, true);
  assert.equal(again.authorizationUrl, null);
});

test('a changed issuer re-keys credentials instead of reusing them', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  const oldKey = new VaultOAuthProvider({ db, userId: user.id, def }).key('tokens');

  // The resource now points at a different authorization server.
  fake.setIssuerPath('/as-b/');
  fake.revokeAccessTokens();

  const r = await startMcpAuthorization({ db, userId: user.id, def, stateToken: 'st-3' });
  assert.equal(r.alreadyConnected, false, 'must not replay the old issuer’s tokens');
  assert.equal(getSecret(db, user.id, 'mcp.miro.issuer'), `${fake.origin}/as-b/`);

  const newKey = new VaultOAuthProvider({ db, userId: user.id, def }).key('tokens');
  assert.notEqual(newKey, oldKey, 'a new issuer means a new key namespace');
  assert.equal(getSecret(db, user.id, newKey), null, 'no tokens carried over');
  assert.ok(getSecret(db, user.id, oldKey), 'the old issuer’s credentials are orphaned, not deleted');
  assert.equal(fake.registrations.length, 2, 're-registered with the new authorization server');
});

test('a byoClient descriptor uses the operator pair instead of registering', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake, { byoClient: true });

  // Phase 3 (Google) shape: no DCR, an operator-provisioned client.
  setSecret(db, user.id, def.byoClientIdKey, 'operator-client-id');
  setSecret(db, user.id, def.byoClientSecretKey, 'operator-client-secret');

  const p = new VaultOAuthProvider({ db, userId: user.id, def });
  assert.deepEqual(p.clientInformation(), {
    client_id: 'operator-client-id', client_secret: 'operator-client-secret',
  });

  // Not configured → undefined, so the SDK reports a real error rather than
  // registering a client Google would reject anyway.
  const other = newUser();
  assert.equal(new VaultOAuthProvider({ db, userId: other.id, def }).clientInformation(), undefined);
});

test('invalidateCredentials clears only the requested scope', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = defFor(fake);
  await connectFully(db, user, def, fake);

  const p = new VaultOAuthProvider({ db, userId: user.id, def });
  p.invalidateCredentials('tokens');
  assert.equal(getSecret(db, user.id, p.key('tokens')), null);
  assert.ok(getSecret(db, user.id, p.key('clientInformation')), 'the registration survives');

  p.invalidateCredentials('all');
  assert.equal(getSecret(db, user.id, p.key('clientInformation')), null);
});

// ── Phase 2b: generic fetch, chunking, dedup ───────────────────────────────

/** A def pointed at `fake`, with a two-level fetch over the fixture's shapes. */
const fetchDef = (fake, over = {}) => defFor(fake, {
  listTool: { name: 'list_boards', args: {}, itemsPath: 'data', idField: 'id', nameField: 'name' },
  readTool: {
    name: 'get_board_items', parentArg: 'board_id', args: {}, itemsPath: 'data',
    idField: 'id', typeField: 'type', textFields: ['data.content', 'text'],
    dateField: 'modifiedAt', linkField: 'links.self',
  },
  mapItem: defaultMcpItemMapper,
  ...over,
});

const BOARD_TOOLS = [
  { name: 'list_boards', handler: () => ({ data: [{ id: 'b1', name: 'Alpha' }, { id: 'b2', name: 'Beta' }] }) },
  {
    name: 'get_board_items',
    handler: (args) => ({
      data: [
        { id: 'i1', type: 'sticky_note', data: { content: `<p>${args.board_id} one</p>` },
          modifiedAt: '2026-08-01T00:00:00.000Z' },
        { id: 'i2', type: 'text', text: `${args.board_id} two`,
          modifiedAt: '2026-08-02T00:00:00.000Z' },
      ],
    }),
  },
];

test('chunkText splits on paragraphs and hard-splits a single huge run', () => {
  assert.deepEqual(chunkText('short', 100), ['short']);
  const paras = chunkText(['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)].join('\n\n'), 100);
  assert.equal(paras.length, 3);
  assert.ok(paras.every((c) => c.length <= 100));
  // One unbroken run longer than the budget must still be split, not emitted
  // whole — otherwise the cap is advisory and a single 200k-char export blows
  // the classify call.
  const hard = chunkText('x'.repeat(250), 100);
  assert.equal(hard.length, 3);
  assert.ok(hard.every((c) => c.length <= 100));
  assert.equal(hard.join(''), 'x'.repeat(250));
  assert.deepEqual(chunkText('', 100), []);
});

test('parseToolResult prefers structuredContent, then JSON, then prose', () => {
  assert.deepEqual(parseToolResult({ structuredContent: { a: 1 }, content: [{ type: 'text', text: 'ignored' }] }), { a: 1 });
  assert.deepEqual(parseToolResult({ content: [{ type: 'text', text: '{"a":2}' }] }), { a: 2 });
  assert.equal(parseToolResult({ content: [{ type: 'text', text: 'just prose' }] }), 'just prose');
  assert.equal(parseToolResult({ content: [] }), null);
  assert.throws(
    () => parseToolResult({ isError: true, content: [{ type: 'text', text: 'board is private' }] }),
    (e) => { assert.equal(e.code, 'MCP_TOOL_ERROR'); assert.match(e.message, /private/); return true; },
  );
});

test('fetch walks list → read and maps every item', async (t) => {
  const fake = await startFakeMcpServer({ tools: BOARD_TOOLS });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake);
  await connectFully(db, user, def, fake);

  const r = await fetchMcpItems(db, user.id, def);
  assert.equal(r.items.length, 4, 'two boards × two items');
  assert.equal(r.drained, true);
  assert.equal(r.overCap, 0);
  assert.deepEqual(r.failures, []);

  // The parent id genuinely reached the read tool — the whole reason the
  // fixture had to become argument-aware.
  const readArgs = fake.toolCalls.filter((c) => c.name === 'get_board_items').map((c) => c.args.board_id);
  assert.deepEqual(readArgs.sort(), ['b1', 'b2']);

  const one = r.items.find((i) => i.id === 'miro:b1:i1');
  assert.ok(one, `expected miro:b1:i1, got ${r.items.map((i) => i.id).join(', ')}`);
  assert.equal(one.body, 'b1 one', 'HTML unwrapped');
  assert.equal(one.fields.Board, 'Alpha');
  assert.equal(one.fields.ItemType, 'sticky_note');
});

test('fetch skips items already in the seen ledger', async (t) => {
  const fake = await startFakeMcpServer({ tools: BOARD_TOOLS });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake);
  await connectFully(db, user, def, fake);

  const first = await fetchMcpItems(db, user.id, def);
  markMcpSeen(db, user.id, def, first.items.map((i) => i.id));

  const second = await fetchMcpItems(db, user.id, def);
  assert.deepEqual(second.items, [], 'a second sweep over unchanged boards is free');
  assert.equal(second.drained, true);
});

test('the cap bounds one fetch and reports the remainder', async (t) => {
  const fake = await startFakeMcpServer({ tools: BOARD_TOOLS });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake);
  await connectFully(db, user, def, fake);

  const r = await fetchMcpItems(db, user.id, def, { limit: 3 });
  assert.equal(r.items.length, 3);
  assert.equal(r.overCap, 1, 'the Mac surfaces this as "1 more pending"');
  assert.equal(r.drained, false, 'a capped fetch has NOT drained the source');
});

test('one failing board does not abort the others', async (t) => {
  const fake = await startFakeMcpServer({
    tools: [
      { name: 'list_boards', handler: () => ({ data: [{ id: 'ok', name: 'Fine' }, { id: 'bad', name: 'Locked' }] }) },
      {
        name: 'get_board_items',
        handler: (args) => {
          if (args.board_id === 'bad') throw new Error('board is private');
          return { data: [{ id: 'i1', text: 'kept' }] };
        },
      },
    ],
  });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake);
  await connectFully(db, user, def, fake);

  const r = await fetchMcpItems(db, user.id, def);
  assert.equal(r.items.length, 1, 'the healthy board still imported');
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /Locked|bad/);
  assert.match(r.failures[0], /private/);
  assert.equal(r.drained, false, 'a partial sweep must not claim to have drained');
});

test('an oversized item is chunked into several notes with stable ids', async (t) => {
  const big = Array.from({ length: 400 }, (_, i) => `paragraph ${i} ${'y'.repeat(80)}`).join('\n\n');
  const fake = await startFakeMcpServer({
    tools: [
      { name: 'list_boards', handler: () => ({ data: [{ id: 'b1', name: 'Alpha' }] }) },
      { name: 'get_board_items', handler: () => ({ data: [{ id: 'huge', type: 'document', text: big }] }) },
    ],
  });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake);
  await connectFully(db, user, def, fake);

  const r = await fetchMcpItems(db, user.id, def, { limit: 100 });
  assert.ok(r.items.length > 1, `expected chunks, got ${r.items.length}`);
  assert.ok(r.items.every((i) => i.body.length <= MAX_ITEM_CHARS));
  assert.deepEqual(r.items.map((i) => i.id), r.items.map((_, k) => `miro:b1:huge#${k + 1}`));
  assert.equal(r.items[0].fields.Part, `1/${r.items.length}`);
  assert.ok(r.items[0].fields.Title.includes('1/'), 'the part shows in the note title');
  // Nothing is lost.
  assert.equal(r.items.map((i) => i.body).join('\n\n').length >= big.length - 10, true);
});

// Four paragraphs, each just under the 12k cap, so chunkText yields exactly
// four chunks — a fixed chunk count the cap tests below can reason about.
const FOUR_CHUNK_BODY = Array.from(
  { length: 4 }, (_, i) => `paragraph ${i} ` + 'y'.repeat(11_000),
).join('\n\n');

const hugeItemTools = (body) => [
  { name: 'list_boards', handler: () => ({ data: [{ id: 'b1', name: 'Alpha' }] }) },
  {
    name: 'get_board_items',
    handler: () => ({ data: [{ id: 'huge', type: 'document', text: body,
      modifiedAt: '2026-08-01T00:00:00.000Z' }] }),
  },
];

test('an oversized item whose chunks are marked is NOT re-imported next sweep', async (t) => {
  // Regression: dedup used to test the BASE id, which a multi-chunk item never
  // emits — so it was never in the ledger and the whole item was re-mapped and
  // re-emitted on every single sweep, forever. With a mis-guessed dateField
  // that is a duplicate note (and a paid classify call) per chunk per sweep.
  const fake = await startFakeMcpServer({ tools: hugeItemTools(FOUR_CHUNK_BODY) });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake);
  await connectFully(db, user, def, fake);

  const first = await fetchMcpItems(db, user.id, def, { limit: 100 });
  assert.deepEqual(first.items.map((i) => i.id),
    ['miro:b1:huge#1', 'miro:b1:huge#2', 'miro:b1:huge#3', 'miro:b1:huge#4']);
  markMcpSeen(db, user.id, def, first.items.map((i) => i.id));

  const second = await fetchMcpItems(db, user.id, def, { limit: 100 });
  assert.deepEqual(second.items, [], 'every chunk id is already in the ledger');
  assert.equal(second.drained, true);

  // A third sweep with nothing newly marked must stay empty too — the bug
  // reproduced identically on every repeat, not just the second.
  const third = await fetchMcpItems(db, user.id, def, { limit: 100 });
  assert.deepEqual(third.items, []);
});

test('a cap-truncated chunked item resumes at the next chunk, not the first', async (t) => {
  // Same root cause seen from the other side: with the base-id check, a
  // 4-chunk item under limit:2 re-emitted #1,#2 forever and #3,#4 never
  // arrived — the item could never finish importing.
  const fake = await startFakeMcpServer({ tools: hugeItemTools(FOUR_CHUNK_BODY) });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake);
  await connectFully(db, user, def, fake);

  const first = await fetchMcpItems(db, user.id, def, { limit: 2 });
  assert.deepEqual(first.items.map((i) => i.id), ['miro:b1:huge#1', 'miro:b1:huge#2']);
  assert.equal(first.overCap, 2);
  assert.equal(first.drained, false);
  markMcpSeen(db, user.id, def, first.items.map((i) => i.id));

  const second = await fetchMcpItems(db, user.id, def, { limit: 2 });
  assert.deepEqual(second.items.map((i) => i.id), ['miro:b1:huge#3', 'miro:b1:huge#4'],
    'the sweep picks up where the cap cut it off');
  assert.equal(second.overCap, 0);
  assert.equal(second.drained, true);
  markMcpSeen(db, user.id, def, second.items.map((i) => i.id));

  const third = await fetchMcpItems(db, user.id, def, { limit: 2 });
  assert.deepEqual(third.items, [], 'now fully imported');
});

test('a list-only descriptor (no readTool) treats list results as the items', async (t) => {
  // gcal in phase 3 is single-level: list_events IS the content. Proving it
  // now keeps the fetch generic rather than Miro-shaped.
  const fake = await startFakeMcpServer({
    tools: [{ name: 'list_events', handler: () => ({ data: [{ id: 'e1', text: 'standup' }] }) }],
  });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake, {
    listTool: { name: 'list_events', args: {}, itemsPath: 'data', idField: 'id', nameField: 'id' },
    readTool: null,
  });
  await connectFully(db, user, def, fake);

  const r = await fetchMcpItems(db, user.id, def);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].body, 'standup');
});

test('fetching without a connection costs nothing and never registers a client', async (t) => {
  const fake = await startFakeMcpServer({ tools: BOARD_TOOLS });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake);

  await assert.rejects(() => fetchMcpItems(db, user.id, def), (e) => {
    assert.equal(e.code, 'MCP_UNAUTHORIZED');
    return true;
  });
  assert.deepEqual(fake.requests, [], 'an ingestion sweep over unconnected users must be free');
});

test('a descriptor with no fetch mapping refuses instead of returning silence', async (t) => {
  const fake = await startFakeMcpServer({ tools: BOARD_TOOLS });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake, { listTool: null, readTool: null });
  await connectFully(db, user, def, fake);

  await assert.rejects(() => fetchMcpItems(db, user.id, def), (e) => {
    assert.equal(e.code, 'MCP_NOT_FETCHABLE');
    return true;
  });
});

test('test now also returns the real tool argument schemas', async (t) => {
  const fake = await startFakeMcpServer({ tools: BOARD_TOOLS });
  t.after(() => fake.close());
  const db = kb.getDb();
  const user = newUser();
  const def = fetchDef(fake);
  await connectFully(db, user, def, fake);

  const r = await testMcpConnection(db, user.id, def);
  assert.deepEqual(r.tools.sort(), ['get_board_items', 'list_boards'], 'unchanged phase-2a shape');
  // Additive. This is how an operator discovers the REAL Miro argument names
  // without reading Miro's docs — the descriptor's guesses are corrected from
  // this response (see mcp-connector-defs.mjs header).
  const schema = r.toolSchemas.find((s) => s.name === 'get_board_items');
  assert.ok(schema, 'every listed tool must appear in toolSchemas');
  assert.equal(schema.inputSchema.type, 'object');
});

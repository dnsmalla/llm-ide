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
} = await import('../connectors/mcp-client.mjs');
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

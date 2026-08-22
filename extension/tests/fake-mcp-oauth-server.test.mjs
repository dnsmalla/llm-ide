// Self-test for tests/fixtures/fake-mcp-oauth-server.mjs.
//
// Uses the raw SDK plus a throwaway in-memory OAuthClientProvider — NOT
// connectors/mcp-client.mjs. That separation is the point: when a test in
// mcp-client.test.mjs fails, this file tells you whether the fixture or the
// code under test broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { startFakeMcpServer } from './fixtures/fake-mcp-oauth-server.mjs';

const REDIRECT = 'http://127.0.0.1:3456/auth/mcp-connector/callback';

function memoryProvider() {
  const store = new Map();
  return {
    authorizationUrl: null,
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() {
      return {
        client_name: 'LLM-IDE', redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none',
        scope: 'boards:read',
      };
    },
    state() { return 'fixture-state'; },
    clientInformation() { return store.get('ci'); },
    saveClientInformation(ci) { store.set('ci', ci); },
    tokens() { return store.get('tok'); },
    saveTokens(t) { store.set('tok', t); },
    saveCodeVerifier(v) { store.set('cv', v); },
    codeVerifier() { return store.get('cv'); },
    redirectToAuthorization(u) { this.authorizationUrl = u.toString(); },
    saveDiscoveryState(ds) { store.set('issuer', ds.authorizationServerUrl); },
    _store: store,
  };
}

test('fixture: unauthenticated connect yields UnauthorizedError after DCR + PKCE', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const transport = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const client = new Client({ name: 'selftest', version: '1' });

  await assert.rejects(() => client.connect(transport), UnauthorizedError);
  await transport.close().catch(() => {});

  // The full discovery chain ran, in order.
  assert.ok(fake.requests.includes('GET /.well-known/oauth-protected-resource'));
  assert.ok(fake.requests.includes('GET /.well-known/oauth-authorization-server'));
  assert.equal(fake.registrations.length, 1, 'exactly one dynamic client registration');
  assert.deepEqual(fake.registrations[0].redirect_uris, [REDIRECT]);

  const authUrl = new URL(provider.authorizationUrl);
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('state'), 'fixture-state');
  assert.equal(authUrl.searchParams.get('redirect_uri'), REDIRECT);
  assert.match(authUrl.searchParams.get('client_id'), /^dcr-/);
  assert.equal(provider._store.get('issuer'), `${fake.origin}/`);
});

test('fixture: authorize() stands in for the browser and finishAuth mints tokens', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await assert.rejects(() => new Client({ name: 's', version: '1' }).connect(t1), UnauthorizedError);
  await t1.close().catch(() => {});

  const { code, state } = await fake.authorize(provider.authorizationUrl);
  assert.match(code, /^code-/);
  assert.equal(state, 'fixture-state', 'the state parameter round-trips');

  // finishAuth works on a transport that was never started.
  const t2 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await t2.finishAuth(code);
  await t2.close().catch(() => {});

  assert.ok(provider.tokens()?.access_token, 'tokens persisted');
  const tokenReq = fake.tokenRequests.at(-1);
  assert.equal(tokenReq.grant_type, 'authorization_code');
  assert.ok(tokenReq.code_verifier, 'the fixture verifies PKCE, so a verifier was sent');
});

test('fixture: a started transport cannot be restarted — use a fresh one', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const c1 = new Client({ name: 's', version: '1' });
  await assert.rejects(() => c1.connect(t1), UnauthorizedError);
  const { code } = await fake.authorize(provider.authorizationUrl);
  await t1.finishAuth(code);

  await assert.rejects(() => c1.connect(t1), /already started/);
  await t1.close().catch(() => {});

  const t2 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const c2 = new Client({ name: 's', version: '1' });
  await c2.connect(t2);
  const { tools } = await c2.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ['get_board_items', 'list_boards']);
  assert.deepEqual(c2.getServerVersion(), { name: 'fake-miro', version: '0.0.1' });
  await c2.close();
});

test('fixture: the warm path makes no OAuth requests at all', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await assert.rejects(() => new Client({ name: 's', version: '1' }).connect(t1), UnauthorizedError);
  const { code } = await fake.authorize(provider.authorizationUrl);
  await t1.finishAuth(code);
  await t1.close().catch(() => {});

  fake.clearLog();
  const t2 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const c2 = new Client({ name: 's', version: '1' });
  await c2.connect(t2);
  await c2.listTools();
  await c2.close();

  assert.ok(fake.requests.every((r) => r.endsWith(' /mcp')),
    `warm path must be /mcp only, saw: ${fake.requests.join(', ')}`);
});

test('fixture: revoked tokens trigger the SDK refresh-token path automatically', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await assert.rejects(() => new Client({ name: 's', version: '1' }).connect(t1), UnauthorizedError);
  const { code } = await fake.authorize(provider.authorizationUrl);
  await t1.finishAuth(code);
  await t1.close().catch(() => {});

  fake.revokeAccessTokens();
  fake.clearLog();
  const t2 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  const c2 = new Client({ name: 's', version: '1' });
  await c2.connect(t2);          // 401 → discovery → refresh_token → retry
  await c2.close();
  assert.equal(fake.tokenRequests.at(-1).grant_type, 'refresh_token');
});

test('fixture: setIssuerPath moves the authorization server', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  fake.setIssuerPath('/as-b/');

  const provider = memoryProvider();
  const t1 = new StreamableHTTPClientTransport(new URL(fake.url), { authProvider: provider });
  await assert.rejects(() => new Client({ name: 's', version: '1' }).connect(t1), UnauthorizedError);
  await t1.close().catch(() => {});
  assert.equal(provider._store.get('issuer'), `${fake.origin}/as-b/`);
});

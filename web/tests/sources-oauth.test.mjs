// Device OAuth for direct reads: PKCE S256 (RFC 7636 vector), read-only authorize URLs, the callback wait (state check,
// closed pop-up, timeout), strict token parsing, and the callback page itself. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { authorizeUrl, callbackUrl, challengeFor, checkConfig, exchangeCode, parseTokens, randomString, refreshTokens, revokeToken, waitForCode, OAuthError } from '../src/sources/oauth.ts';

const GL = { clientId: 'a'.repeat(64) };
const BOX = { clientId: 'b'.repeat(32), clientSecret: 'boxsecret0123456789abcdef' };
const code = (c) => (e) => { assert.ok(e instanceof OAuthError); assert.equal(e.code, c); return true; };

test('PKCE: the RFC 7636 appendix B vector, and verifiers are 43 url-safe characters', async () => {
  assert.equal(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const v = randomString();
  assert.match(v, /^[A-Za-z0-9_-]{43}$/);
});

test('authorize URLs ask for read-only scopes with S256', () => {
  const g = new URL(authorizeUrl('gitlab', GL, 'https://llm-ide.com/app/oauth-callback.html', 'st', 'ch'));
  assert.equal(g.origin + g.pathname, 'https://gitlab.com/oauth/authorize');
  assert.equal(g.searchParams.get('scope'), 'read_api read_repository');
  assert.equal(g.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(g.searchParams.get('response_type'), 'code');
  const b = new URL(authorizeUrl('box', BOX, 'https://llm-ide.com/app/oauth-callback.html', 'st', 'ch'));
  assert.equal(b.origin + b.pathname, 'https://account.box.com/api/oauth2/authorize');
  assert.equal(b.searchParams.get('scope'), 'root_readonly');
  assert.equal(b.searchParams.has('client_secret'), false, 'the secret never goes into a URL');
  assert.equal(new URL(authorizeUrl('box', BOX, 'x', 's', 'c', 'root_readwrite')).searchParams.get('scope'), 'root_readwrite', 'SP6 passes its own scope');
  assert.equal(callbackUrl('https://llm-ide.com/app/'), 'https://llm-ide.com/app/oauth-callback.html');
  assert.equal(callbackUrl('http://127.0.0.1:5180/'), 'http://127.0.0.1:5180/oauth-callback.html');
});

test('config: IDs and the Box secret are shape-checked', () => {
  assert.deepEqual(checkConfig('gitlab', { clientId: GL.clientId, clientSecret: 'dropped' }), GL);
  assert.throws(() => checkConfig('gitlab', { clientId: 'x' }), code('bad_client_id'));
  assert.throws(() => checkConfig('box', { clientId: BOX.clientId }), code('bad_client_secret'));
});

test('waitForCode: ignores other states, resolves the matching code, rejects closed pop-ups and timeouts', async () => {
  const ch = { onmessage: null, closed: 0, close() { this.closed += 1; } };
  let tick = null; const every = (fn) => { tick = fn; return () => { tick = null; }; };
  const p = waitForCode('S1', ch, { every });
  ch.onmessage({ data: { state: 'other', code: 'evil-code-123' } });
  ch.onmessage({ data: { state: 'S1', code: 'good-code-123' } });
  assert.equal(await p, 'good-code-123');
  assert.equal(ch.closed, 1); assert.equal(tick, null);
  let closed = false;
  const q = waitForCode('S2', { onmessage: null, close() {} }, { every, isClosed: () => closed });
  closed = true; tick();
  await assert.rejects(q, code('sign_in_cancelled'));
  const r = waitForCode('S3', { onmessage: null, close() {} }, { every, timeoutMs: 2000 });
  tick(); tick();
  await assert.rejects(r, code('sign_in_timeout'));
  const c = { onmessage: null, close() {} };
  const d = waitForCode('S4', c, { every });
  c.onmessage({ data: { state: 'S4', error: 'access_denied' } });
  await assert.rejects(d, code('sign_in_cancelled'));
});

const GL_SCOPE = 'read_api read_repository';
test('tokens: strict parse, wide scopes refused, expiry a minute early', () => {
  const t = parseTokens({ access_token: 'acc-12345678', refresh_token: 'ref-1', expires_in: 7200, scope: 'read_api read_repository' }, 1000, GL_SCOPE, true);
  assert.deepEqual(t, { access: 'acc-12345678', refresh: 'ref-1', expiresAt: 1000 + 7200_000 - 60_000 });
  assert.throws(() => parseTokens({ access_token: 'acc-12345678', scope: 'api read_api' }, 0, GL_SCOPE, true), code('scope_too_wide'));
  assert.throws(() => parseTokens({ access_token: 'acc-12345678', scope: 'read_api read_repository sudo' }, 0, GL_SCOPE, true), code('scope_too_wide'));
  assert.throws(() => parseTokens({ access_token: 'acc-12345678' }, 0, GL_SCOPE, true), code('scope_too_wide'), 'GitLab without a scope field is refused');
  assert.throws(() => parseTokens({ access_token: 'acc-12345678', scope: 'root_readwrite' }, 0, 'root_readonly', false), code('scope_too_wide'));
  assert.throws(() => parseTokens({ access_token: 3 }, 0, GL_SCOPE, true), code('bad_token_response'));
  assert.equal(parseTokens({ access_token: 'acc-12345678' }, 0, 'root_readonly', false).refresh, null, 'Box returns no scope field');
});

test('exchange, refresh and revoke post the right forms; Box adds its secret, GitLab never has one', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)), init }); return new Response(JSON.stringify({ access_token: 'acc-12345678', refresh_token: 'r2', expires_in: 3600, ...(url.includes('gitlab') ? { scope: 'read_api read_repository' } : {}) }), { status: 200 }); };
  await exchangeCode('gitlab', GL, 'good-code-123', 'verif', 'https://x/cb', fetchImpl, () => 0);
  assert.equal(seen[0].url, 'https://gitlab.com/oauth/token');
  assert.deepEqual(seen[0].form, { grant_type: 'authorization_code', code: 'good-code-123', client_id: GL.clientId, redirect_uri: 'https://x/cb', code_verifier: 'verif' });
  assert.equal(seen[0].init.credentials, 'omit');
  await exchangeCode('box', BOX, 'good-code-123', 'verif', 'https://x/cb', fetchImpl, () => 0);
  assert.equal(seen[1].url, 'https://api.box.com/oauth2/token');
  assert.equal(seen[1].form.client_secret, BOX.clientSecret);
  await refreshTokens('gitlab', GL, 'r1', 'https://x/cb', fetchImpl, () => 0);
  assert.deepEqual(seen[2].form, { grant_type: 'refresh_token', refresh_token: 'r1', client_id: GL.clientId, redirect_uri: 'https://x/cb' });
  await revokeToken('box', BOX, 'acc-12345678', fetchImpl);
  assert.equal(seen[3].url, 'https://api.box.com/oauth2/revoke');
  assert.deepEqual(seen[3].form, { client_id: BOX.clientId, token: 'acc-12345678', client_secret: BOX.clientSecret });
  const refuse = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  await assert.rejects(exchangeCode('gitlab', GL, 'c-123456789', 'v', 'u', refuse), code('grant_expired'));
  await assert.rejects(exchangeCode('gitlab', GL, 'c-123456789', 'v', 'u', async () => { throw new TypeError('fetch failed'); }), code('unreachable'));
  await revokeToken('gitlab', GL, 't', async () => { throw new TypeError('x'); }); // best effort: never throws
});

test('the callback page strips the code from the address, posts it on the channel, and closes', () => {
  const dir = join(import.meta.dirname, '../public');
  const html = readFileSync(join(dir, 'oauth-callback.html'), 'utf8');
  assert.match(html, /<script src="\.\/oauth-callback\.js"><\/script>/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'/);
  const posted = []; const replaced = []; let closed = false;
  const el = { textContent: '' };
  vm.runInNewContext(readFileSync(join(dir, 'oauth-callback.js'), 'utf8'), {
    URLSearchParams,
    location: { search: '?code=good-code-123&state=S1', pathname: '/app/oauth-callback.html' },
    history: { replaceState: (...a) => replaced.push(a) },
    BroadcastChannel: class { constructor(n) { this.n = n; } postMessage(m) { posted.push([this.n, m]); } close() {} },
    document: { getElementById: () => el },
    setTimeout: (fn) => fn(),
    window: { close: () => { closed = true; } },
  });
  assert.deepEqual(replaced[0], [null, '', '/app/oauth-callback.html']);
  assert.equal(posted.length, 1); assert.equal(posted[0][0], 'llmide-oauth'); assert.deepEqual({ ...posted[0][1] }, { state: 'S1', code: 'good-code-123', error: null });
  assert.equal(closed, true);
  assert.match(el.textContent, /close this window/);
});

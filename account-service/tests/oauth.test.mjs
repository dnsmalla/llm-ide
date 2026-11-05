import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_CLIENT,
  DESKTOP_REDIRECT,
  OAUTH_STATE,
  authorize,
  linkToken,
  pkcePair,
  rawRequest,
  signInDesktop,
  signUpAndRegister,
  startApp,
  tokenRequest,
  waitForMail,
} from './helpers.mjs';

const codeFields = (code, verifier) => ({
  grant_type: 'authorization_code',
  code,
  redirect_uri: DESKTOP_REDIRECT,
  client_id: DESKTOP_CLIENT,
  code_verifier: verifier,
});

async function authorizedCode(app, web, { redirectUri = DESKTOP_REDIRECT } = {}) {
  const { verifier, challenge } = pkcePair();
  const res = await authorize(app, web, { challenge, redirectUri });
  if (res.status !== 302) throw new Error(`authorize ${res.status} ${JSON.stringify(res.body)}`);
  return { verifier, challenge, code: new URL(res.headers.location).searchParams.get('code'), res };
}

test('authorization code + PKCE: a full session gets a code and the desktop exchanges it', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const web = app.client();
  await signUpAndRegister(app, web);
  const { verifier, code, res } = await authorizedCode(app, web);

  assert.equal(res.status, 302);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  const location = new URL(res.headers.location);
  assert.equal(location.origin + location.pathname, DESKTOP_REDIRECT);
  assert.equal(location.searchParams.get('state'), OAUTH_STATE);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);

  // Only the SHA-256 hash is stored, with the exact redirect and challenge.
  const row = app.db.prepare('SELECT * FROM oauth_codes').get();
  assert.notEqual(row.code_hash, code);
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.client_id, DESKTOP_CLIENT);
  assert.equal(row.redirect_uri, DESKTOP_REDIRECT);
  assert.equal(row.code_challenge_method, 'S256');
  assert.equal(row.used_at, null);

  const token = await tokenRequest(app, codeFields(code, verifier));
  assert.equal(token.status, 200);
  assert.deepEqual(Object.keys(token.body).sort(), ['access_token', 'expires_in', 'refresh_token', 'token_type']);
  assert.equal(token.body.token_type, 'Bearer');
  assert.equal(token.body.expires_in, 900);
  assert.match(token.body.access_token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(token.body.refresh_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token.headers['set-cookie'], undefined);
  assert.equal(token.headers['access-control-allow-origin'], undefined);
  assert.ok(app.db.prepare('SELECT used_at FROM oauth_codes').pluck().get() > 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM desktop_tokens').pluck().get(), 2);
  const hashes = app.db.prepare('SELECT id_hash FROM desktop_tokens').pluck().all();
  assert.equal(hashes.includes(token.body.access_token), false);
  assert.equal(hashes.includes(token.body.refresh_token), false);
});

test('the token endpoint accepts JSON from the service origin and refuses other content types', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const web = app.client();
  await signUpAndRegister(app, web);
  const { verifier, code } = await authorizedCode(app, web);

  const json = await web.call('POST', '/v1/oauth/token', codeFields(code, verifier));
  assert.equal(json.status, 200);
  assert.equal(json.body.token_type, 'Bearer');

  const plain = await rawRequest(app.base, 'POST', '/v1/oauth/token', 'grant_type=authorization_code', {
    'content-type': 'text/plain',
  });
  assert.equal(plain.status, 415);
  assert.deepEqual(plain.body, { error: 'unsupported_content_type' });

  const missing = await tokenRequest(app, {});
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: 'invalid_request' });

  const unsupported = await tokenRequest(app, { grant_type: 'client_credentials', client_id: DESKTOP_CLIENT });
  assert.equal(unsupported.status, 400);
  assert.deepEqual(unsupported.body, { error: 'unsupported_grant_type' });
});

test('a wrong PKCE verifier is refused and does not consume the code', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const web = app.client();
  await signUpAndRegister(app, web);
  const { verifier, code } = await authorizedCode(app, web);

  const wrong = await tokenRequest(app, codeFields(code, pkcePair().verifier));
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body, { error: 'invalid_grant' });
  assert.equal(app.db.prepare('SELECT used_at FROM oauth_codes').pluck().get(), null);

  const short = await tokenRequest(app, codeFields(code, 'too-short'));
  assert.equal(short.status, 400);
  assert.deepEqual(short.body, { error: 'invalid_grant' });

  const good = await tokenRequest(app, codeFields(code, verifier));
  assert.equal(good.status, 200);
});

test('a replayed code is refused and revokes the tokens it granted', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const web = app.client();
  await signUpAndRegister(app, web);
  const { verifier, code } = await authorizedCode(app, web);

  const first = await tokenRequest(app, codeFields(code, verifier));
  assert.equal(first.status, 200);
  const replay = await tokenRequest(app, codeFields(code, verifier));
  assert.equal(replay.status, 400);
  assert.deepEqual(replay.body, { error: 'invalid_grant' });
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM desktop_tokens WHERE revoked_at IS NULL').pluck().get(), 0);
});

test('an expired code is refused', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const web = app.client();
  await signUpAndRegister(app, web);
  const { verifier, code } = await authorizedCode(app, web);

  app.clock.advance(60_001);
  const token = await tokenRequest(app, codeFields(code, verifier));
  assert.equal(token.status, 400);
  assert.deepEqual(token.body, { error: 'invalid_grant' });
});

test('refresh tokens rotate: each one is single use and the chain continues', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);

  const rotated = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: DESKTOP_CLIENT,
  });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.expires_in, 900);
  assert.notEqual(rotated.body.access_token, tokens.access_token);
  assert.notEqual(rotated.body.refresh_token, tokens.refresh_token);

  const again = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: rotated.body.refresh_token,
    client_id: DESKTOP_CLIENT,
  });
  assert.equal(again.status, 200);
  assert.notEqual(again.body.refresh_token, rotated.body.refresh_token);
  assert.equal(
    app.db.prepare("SELECT COUNT(*) FROM desktop_tokens WHERE kind = 'refresh' AND used_at IS NOT NULL").pluck().get(),
    2,
  );
});

test('refresh reuse revokes the whole family', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);

  const rotated = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: DESKTOP_CLIENT,
  });
  assert.equal(rotated.status, 200);

  const reused = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: DESKTOP_CLIENT,
  });
  assert.equal(reused.status, 400);
  assert.deepEqual(reused.body, { error: 'invalid_grant' });

  // The rotated refresh token and the access token in the same family are dead too.
  const deadRefresh = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: rotated.body.refresh_token,
    client_id: DESKTOP_CLIENT,
  });
  assert.equal(deadRefresh.status, 400);
  assert.deepEqual(deadRefresh.body, { error: 'invalid_grant' });

  const deadAccess = await rawRequest(app.base, 'POST', '/v1/desktop', '{}', {
    'content-type': 'application/json',
    authorization: `Bearer ${rotated.body.access_token}`,
  });
  assert.equal(deadAccess.status, 401);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM desktop_tokens WHERE revoked_at IS NULL').pluck().get(), 0);
});

test('authorize validates the client, redirect URI, PKCE and state', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const web = app.client();
  await signUpAndRegister(app, web);
  const { challenge } = pkcePair();

  const cases = [
    [{ challenge, clientId: 'another-client' }, 400, 'invalid_client'],
    [{ challenge, redirectUri: 'http://localhost:49152/auth/callback' }, 400, 'invalid_request'],
    [{ challenge, redirectUri: 'https://127.0.0.1:49152/auth/callback' }, 400, 'invalid_request'],
    [{ challenge, redirectUri: 'http://127.0.0.1:80/auth/callback' }, 400, 'invalid_request'],
    [{ challenge, redirectUri: 'http://127.0.0.1:01024/auth/callback' }, 400, 'invalid_request'],
    [{ challenge, redirectUri: 'http://127.0.0.1:65536/auth/callback' }, 400, 'invalid_request'],
    [{ challenge, redirectUri: `${DESKTOP_REDIRECT}/` }, 400, 'invalid_request'],
    [{ challenge, redirectUri: 'llmide://auth/callback/' }, 400, 'invalid_request'],
    [{ challenge: 'x'.repeat(42) }, 400, 'invalid_request'],
    [{ challenge: 'x'.repeat(129) }, 400, 'invalid_request'],
    [{ challenge, method: 'plain' }, 400, 'invalid_request'],
    [{ challenge, state: null }, 400, 'invalid_request'],
    [{ challenge, state: 'bad state' }, 400, 'invalid_request'],
    [{ challenge, state: 'x'.repeat(257) }, 400, 'invalid_request'],
    [{ challenge, responseType: 'token' }, 400, 'unsupported_response_type'],
  ];
  for (const [params, status, error] of cases) {
    const res = await authorize(app, web, params);
    assert.equal(res.status, status, JSON.stringify(params));
    assert.deepEqual(res.body, { error }, JSON.stringify(params));
  }

  // Ephemeral loopback ports 1024 and 65535 are allowed, as is the custom-scheme fallback.
  for (const redirectUri of ['http://127.0.0.1:1024/auth/callback', 'http://127.0.0.1:65535/auth/callback', 'llmide://auth/callback']) {
    const res = await authorize(app, web, { challenge, redirectUri });
    assert.equal(res.status, 302, redirectUri);
    assert.ok(res.headers.location.startsWith(`${redirectUri}?code=`), res.headers.location);
  }
});

test('authorize requires a full web session, not a setup session', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { challenge } = pkcePair();

  const anonymous = await authorize(app, app.client(), { challenge });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.body, { error: 'unauthenticated' });

  const pending = app.client();
  const before = app.mailer.sent.length;
  await pending.call('POST', '/v1/signup', { email: 'ada@example.com', displayName: 'Ada', language: 'en', timeZone: 'Asia/Tokyo' });
  const token = linkToken(await waitForMail(app.mailer, before + 1));
  await pending.call('POST', '/v1/signup/verify', { token });
  const setup = await authorize(app, pending, { challenge });
  assert.equal(setup.status, 401);
  assert.deepEqual(setup.body, { error: 'unauthenticated' });
});

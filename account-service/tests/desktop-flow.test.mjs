import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DESKTOP_CLIENT,
  desktopBody,
  rawRequest,
  signInDesktop,
  startApp,
  tokenRequest,
} from './helpers.mjs';

const RUST_CLIENT = new URL('../../desktop/src-tauri/src/account_oauth.rs', import.meta.url);

const bearer = (token) => ({ authorization: `Bearer ${token}` });

// Design 4.4 end to end, as the desktop (account_oauth.rs) performs it against the real service.
test('desktop flow: authorize, PKCE exchange, profile read, registration, sign-out revoke', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);

  const profile = await rawRequest(app.base, 'GET', '/v1/desktop/account', undefined, bearer(tokens.access_token));
  assert.equal(profile.status, 200);
  assert.equal(profile.body.email, 'ada@example.com');
  assert.equal(profile.headers['set-cookie'], undefined);

  const reg = await rawRequest(app.base, 'POST', '/v1/desktop', JSON.stringify(desktopBody(tokens.access_token)), {
    'content-type': 'application/json', ...bearer(tokens.access_token),
  });
  assert.equal(reg.status, 201);

  const revoke = await rawRequest(app.base, 'POST', '/v1/oauth/revoke', new URLSearchParams({ client_id: DESKTOP_CLIENT, token: tokens.refresh_token }).toString(), {
    'content-type': 'application/x-www-form-urlencoded',
  });
  assert.equal(revoke.status, 200);
  const refresh = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: DESKTOP_CLIENT });
  assert.equal(refresh.status, 400);
  assert.equal((await rawRequest(app.base, 'GET', '/v1/desktop/account', undefined, bearer(tokens.access_token))).status, 401);
});

test('the desktop profile route takes only a live access token, never a cookie or refresh token', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { web, tokens } = await signInDesktop(app);

  const cookieOnly = await rawRequest(app.base, 'GET', '/v1/desktop/account', undefined, { cookie: web.cookie });
  assert.equal(cookieOnly.status, 401);
  const refreshAsBearer = await rawRequest(app.base, 'GET', '/v1/desktop/account', undefined, bearer(tokens.refresh_token));
  assert.equal(refreshAsBearer.status, 401);
  app.clock.advance(15 * 60_000);
  assert.equal((await rawRequest(app.base, 'GET', '/v1/desktop/account', undefined, bearer(tokens.access_token))).status, 401);

  // The web profile route stays cookie-only: a Bearer token there is still unauthenticated.
  const webWithBearer = await rawRequest(app.base, 'GET', '/v1/account', undefined, bearer(tokens.access_token));
  assert.equal(webWithBearer.status, 401);
});

// Contract: every service path the desktop client calls must be a route the service serves.
test('every account path in account_oauth.rs is a served route', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const src = readFileSync(RUST_CLIENT, 'utf8');
  const paths = [...src.matchAll(/\{origin\}(v1\/[a-z/]+)/g)].map((m) => `/${m[1]}`);
  assert.ok(paths.includes('/v1/desktop/account'), 'the desktop reads its profile from /v1/desktop/account');
  assert.ok(!paths.includes('/v1/account'), 'the cookie-only web route is not a desktop route');
  for (const path of new Set(paths)) {
    const method = path === '/v1/desktop/account' ? 'GET' : 'POST';
    // A body-less request: served routes answer 401/415, an unknown path 404.
    const res = await rawRequest(app.base, method, path, undefined, {});
    assert.notEqual(res.status, 404, `${method} ${path}`);
  }
  // The Settings card offers Replace on exactly the text the Rust client returns for 409 desktop_exists.
  const ui = readFileSync(new URL('../../ui/screens/settings/sections/AccountSection.tsx', import.meta.url), 'utf8');
  const exists = /pub const DESKTOP_EXISTS: &str = "([^"]+)";/.exec(src)?.[1];
  assert.ok(exists && ui.includes(`const DESKTOP_EXISTS = "${exists}";`));
  assert.match(src, /ureq::get\(&format!\("\{origin\}v1\/desktop\/account"\)\)\s*\.set\("authorization", &format!\("Bearer \{\}"/);
});

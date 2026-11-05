import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_CLIENT,
  ORIGIN,
  rawRequest,
  signInDesktop,
  startApp,
  tokenRequest,
} from './helpers.mjs';

const SIGNING_KEY = `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${'a'.repeat(86)}`;
const ECDH_KEY = `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${'b'.repeat(86)}`;
const body = { label: 'Ada Mac', signingKey: SIGNING_KEY, ecdhKey: ECDH_KEY };

function register(app, token, payload = body, headers = {}) {
  return rawRequest(app.base, 'POST', '/v1/desktop', JSON.stringify(payload), {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  });
}

test('the desktop registers its signing and ECDH public keys once', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);

  // The desktop's Node core sends no Origin: that is the native-client case.
  const res = await register(app, tokens.access_token, { ...body, label: '  Ada Mac  ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'desktop_registered');
  assert.equal(res.body.device.kind, 'desktop');
  assert.equal(res.body.device.label, 'Ada Mac');
  assert.equal(res.body.device.status, 'linked');
  assert.equal(res.body.device.tier, 'desktop');
  assert.equal(res.headers['access-control-allow-origin'], undefined);

  const row = app.db.prepare('SELECT * FROM devices').get();
  assert.equal(row.id, res.body.device.id);
  assert.equal(row.user_id, app.db.prepare('SELECT id FROM users').pluck().get());
  assert.equal(row.signing_key, SIGNING_KEY);
  assert.equal(row.ecdh_key, ECDH_KEY);
  assert.equal(row.status, 'linked');
  assert.equal(row.token_hash, null); // no device token until the relay sub-project
  assert.equal(row.created_at, row.linked_at);

  // One desktop per account is enforced in the schema, not only by the route's check.
  const index = app.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'devices_one_desktop_per_user'").get();
  assert.match(index.sql, /CREATE UNIQUE INDEX .* ON devices\(user_id\) WHERE kind = 'desktop'/);
});

test('a second desktop for the same account is 409 desktop_exists', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);

  assert.equal((await register(app, tokens.access_token)).status, 201);
  const conflict = await register(app, tokens.access_token);
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { error: 'desktop_exists' });

  // A rotated access token belongs to the same account and sees the same rule.
  const rotated = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: DESKTOP_CLIENT,
  });
  assert.equal(rotated.status, 200);
  const again = await register(app, rotated.body.access_token);
  assert.equal(again.status, 409);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM devices').pluck().get(), 1);
});

test('desktop registration requires a live access token', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);

  const missing = await register(app, null);
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, { error: 'unauthenticated' });

  const refreshAsBearer = await register(app, tokens.refresh_token);
  assert.equal(refreshAsBearer.status, 401);
  assert.deepEqual(refreshAsBearer.body, { error: 'unauthenticated' });

  const unknown = await register(app, 'x'.repeat(43));
  assert.equal(unknown.status, 401);

  app.clock.advance(15 * 60_000); // the access token expires; the refresh token does not
  const expired = await register(app, tokens.access_token);
  assert.equal(expired.status, 401);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM devices').pluck().get(), 0);
});

test('desktop registration refuses a foreign Origin and invalid keys or labels', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);

  const foreign = await register(app, tokens.access_token, body, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.deepEqual(foreign.body, { error: 'bad_origin' });

  const emptyLabel = await register(app, tokens.access_token, { ...body, label: '   ' });
  assert.equal(emptyLabel.status, 400);
  assert.deepEqual(emptyLabel.body, { error: 'invalid_label' });

  const shortKey = await register(app, tokens.access_token, { ...body, signingKey: 'too-short' });
  assert.equal(shortKey.status, 400);
  assert.deepEqual(shortKey.body, { error: 'invalid_key' });

  const unknownField = await register(app, tokens.access_token, { ...body, tier: 'full' });
  assert.equal(unknownField.status, 400);
  assert.deepEqual(unknownField.body, { error: 'invalid_payload' });

  // The exact service origin is accepted as well, so a page on the accounts origin can call it.
  const sameOrigin = await register(app, tokens.access_token, body, { origin: ORIGIN });
  assert.equal(sameOrigin.status, 201);
});

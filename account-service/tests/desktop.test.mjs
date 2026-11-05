import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DESKTOP_CLIENT,
  DESKTOP_REDIRECT,
  ORIGIN,
  authorize,
  desktopBody,
  desktopKeys,
  desktopProof,
  pkcePair,
  rawRequest,
  signInDesktop,
  startApp,
  tokenRequest,
} from './helpers.mjs';

function register(app, token, payload = desktopBody(token ?? ''), headers = {}, path = '/v1/desktop') {
  return rawRequest(app.base, 'POST', path, JSON.stringify(payload), {
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
  const keys = desktopKeys();
  const res = await register(app, tokens.access_token, desktopBody(tokens.access_token, keys, '  Ada Mac  '));
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
  assert.equal(row.signing_key, keys.signingKey);
  assert.equal(row.ecdh_key, keys.ecdhKey);
  assert.equal(row.status, 'linked');
  assert.equal(row.token_hash, null); // no device token until the relay sub-project
  assert.equal(row.created_at, row.linked_at);

  // One live desktop per account is enforced in the schema, not only by the route's check.
  const index = app.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'devices_one_live_desktop_per_user'").get();
  assert.match(index.sql, /CREATE UNIQUE INDEX .* ON devices\(user_id\) WHERE kind = 'desktop' AND status <> 'revoked'/);
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
  const again = await register(app, rotated.body.access_token, desktopBody(rotated.body.access_token));
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

  const body = desktopBody(tokens.access_token);
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

const spki = (publicKey) => publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

test('desktop keys must be P-256 SPKI (base64url DER); anything else is invalid_key', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);
  const keys = desktopKeys();
  const withKeys = (k) => ({ label: 'Ada Mac', signingKey: k.signingKey, ecdhKey: k.ecdhKey, proof: desktopProof(tokens.access_token, k) });

  const fakeSpki = `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${'a'.repeat(86)}`; // right prefix, not a curve point
  const p384 = spki(generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey);
  const x25519 = spki(generateKeyPairSync('x25519').publicKey);
  const rsa = spki(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey);
  const pem = keys.signing.publicKey.export({ type: 'spki', format: 'pem' });
  for (const bad of [fakeSpki, p384, x25519, rsa, pem, `${keys.ecdhKey}==`, 'too-short']) {
    const res = await register(app, tokens.access_token, withKeys({ ...keys, ecdhKey: bad }));
    assert.equal(res.status, 400, bad.slice(0, 40));
    assert.deepEqual(res.body, { error: 'invalid_key' });
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM devices').pluck().get(), 0);
  assert.equal((await register(app, tokens.access_token, withKeys(keys))).status, 201);
});

test('registration needs proof of possession of the signing key, bound to the access token', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { tokens } = await signInDesktop(app);
  const keys = desktopKeys();
  const base = { label: 'Ada Mac', signingKey: keys.signingKey, ecdhKey: keys.ecdhKey };
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;

  const cases = {
    missing: base,
    garbage: { ...base, proof: 'A'.repeat(86) },
    otherKey: { ...base, proof: desktopProof(tokens.access_token, keys, other) },
    otherToken: { ...base, proof: desktopProof('x'.repeat(43), keys) },
    swappedKeys: { ...base, ecdhKey: desktopKeys().ecdhKey, proof: desktopProof(tokens.access_token, keys) },
  };
  for (const [name, payload] of Object.entries(cases)) {
    const res = await register(app, tokens.access_token, payload);
    assert.equal(res.status, 400, name);
    assert.deepEqual(res.body, { error: 'invalid_proof' }, name);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM devices').pluck().get(), 0);
  assert.equal((await register(app, tokens.access_token, { ...base, proof: desktopProof(tokens.access_token, keys) })).status, 201);
});

// Fixed vector from account_oauth.rs `proof_matches_the_service_vector`: RFC 6979 makes p256 signing
// deterministic, so the Rust signer and this verifier stay pinned to the same message and encoding.
test('the desktop proof format matches the Rust signer', async () => {
  const { desktopProofMessage, verifyDesktopProof } = await import('../src/devices.mjs');
  const v = JSON.parse(readFileSync(new URL('./fixtures/desktop-proof-vector.json', import.meta.url), 'utf8'));
  assert.equal(desktopProofMessage(v.tokenHash, v.signingKey, v.ecdhKey), v.message);
  assert.doesNotThrow(() => verifyDesktopProof({ tokenHash: v.tokenHash, signingKey: v.signingKey, ecdhKey: v.ecdhKey, proof: v.proof }));
});

test('replace desktop (4.7): fresh sign-in only, revokes the old desktop and its tokens, mails the user', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const first = await signInDesktop(app);
  assert.equal((await register(app, first.tokens.access_token)).status, 201);
  const oldId = app.db.prepare('SELECT id FROM devices').pluck().get();
  // A linked phone (linking itself is a later sub-project): replace must unlink it.
  app.db.prepare(`INSERT INTO devices (id, user_id, kind, label, status, signing_key, ecdh_key, tier, created_at, updated_at)
    SELECT 'phone-1', user_id, 'ios', 'Phone', 'linked', signing_key, ecdh_key, 'ios', 0, 0 FROM devices`).run();
  const mails = app.mailer.sent.length;

  // A new computer signs in (fresh passkey proof) and gets 409, then chooses Replace.
  const second = await signInDesktop(app, { reuse: first.web });
  assert.equal((await register(app, second.tokens.access_token)).status, 409);
  const pending = pkcePair();
  const pendingCode = new URL((await authorize(app, first.web, { challenge: pending.challenge })).headers.location).searchParams.get('code');
  const replaced = await register(app, second.tokens.access_token, desktopBody(second.tokens.access_token, desktopKeys(), 'New Mac'), {}, '/v1/desktop/replace');
  assert.equal(replaced.status, 201);
  assert.equal(replaced.body.status, 'desktop_replaced');
  assert.equal(replaced.body.device.label, 'New Mac');

  const rows = app.db.prepare("SELECT id, status FROM devices WHERE kind = 'desktop' ORDER BY created_at").all();
  assert.deepEqual(rows.map((r) => r.status), ['revoked', 'linked']);
  assert.equal(rows[0].id, oldId);
  assert.equal(app.db.prepare("SELECT status FROM devices WHERE id = 'phone-1'").pluck().get(), 'unlinked');
  // The old desktop's refresh family is dead; the new desktop's still works.
  const oldRefresh = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: first.tokens.refresh_token, client_id: DESKTOP_CLIENT });
  assert.equal(oldRefresh.status, 400);
  const newRefresh = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: second.tokens.refresh_token, client_id: DESKTOP_CLIENT });
  assert.equal(newRefresh.status, 200);
  // A sign-in code issued before the replace cannot mint tokens afterwards.
  const late = await tokenRequest(app, { grant_type: 'authorization_code', code: pendingCode, redirect_uri: DESKTOP_REDIRECT, client_id: DESKTOP_CLIENT, code_verifier: pending.verifier });
  assert.equal(late.status, 400);
  assert.equal(app.db.prepare("SELECT COUNT(*) FROM audit_events WHERE event = 'desktop_replaced'").pluck().get(), 1);
  for (let i = 0; i < 400 && app.mailer.sent.length === mails; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.match(app.mailer.sent.at(-1).subject, /desktop was replaced/i);
});

test('replace desktop refuses a stale sign-in, a missing proof, and a refresh-rotated stale token', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const first = await signInDesktop(app);
  assert.equal((await register(app, first.tokens.access_token)).status, 201);
  const path = '/v1/desktop/replace';

  app.clock.advance(6 * 60_000); // the passkey proof behind this token is now older than 5 minutes
  const stale = await register(app, first.tokens.access_token, desktopBody(first.tokens.access_token), {}, path);
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.body, { error: 'reauth_required' });
  // Rotating the refresh token does not make the sign-in fresh again.
  const rotated = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: first.tokens.refresh_token, client_id: DESKTOP_CLIENT });
  const rotatedRes = await register(app, rotated.body.access_token, desktopBody(rotated.body.access_token), {}, path);
  assert.equal(rotatedRes.status, 401);
  assert.deepEqual(rotatedRes.body, { error: 'reauth_required' });

  const keys = desktopKeys();
  const noProof = await register(app, rotated.body.access_token, { label: 'x', signingKey: keys.signingKey, ecdhKey: keys.ecdhKey }, {}, path);
  assert.equal(noProof.status, 400);
  assert.equal(app.db.prepare("SELECT COUNT(*) FROM devices WHERE status = 'linked'").pluck().get(), 1);
});

test('72 h after an email recovery, replacing or re-registering a desktop is held (Q4)', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const first = await signInDesktop(app);
  assert.equal((await register(app, first.tokens.access_token)).status, 201);
  app.db.prepare('UPDATE users SET recovered_at = ?').run(app.clock.now());

  const second = await signInDesktop(app, { reuse: first.web });
  const held = await register(app, second.tokens.access_token, desktopBody(second.tokens.access_token), {}, '/v1/desktop/replace');
  assert.equal(held.status, 403);
  assert.deepEqual(held.body, { error: 'desktop_change_held' });

  // Revoking the desktop from the web does not open a side door: a new registration is held too.
  app.db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ?").run(app.clock.now());
  const reRegister = await register(app, second.tokens.access_token);
  assert.equal(reRegister.status, 403);
  assert.deepEqual(reRegister.body, { error: 'desktop_change_held' });

  app.clock.advance(72 * 60 * 60_000);
  const later = await signInDesktop(app, { reuse: first.web, fresh: true });
  assert.equal((await register(app, later.tokens.access_token)).status, 201);
});

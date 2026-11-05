import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { insertUser, linkToken, ORIGIN, rawRequest, signUpAndRegister, startApp, waitForMail } from './helpers.mjs';

const form = { email: 'ada@example.com', displayName: 'Ada', language: 'en', timeZone: 'UTC' };

test('direct signup creates a pending account and setup session without email', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_DIRECT_SIGNUP: '1' } });
  t.after(() => app.close());
  const c = app.client();
  const res = await c.call('POST', '/v1/signup/direct', form);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { status: 'add_passkey' });
  assert.match(c.cookie, /^llmide_session=/);
  const user = app.db.prepare('SELECT * FROM users').get();
  assert.equal(user.status, 'pending_passkey');
  assert.equal(app.mailer.sent.length, 0);
  assert.equal(app.db.prepare('SELECT scope, via FROM sessions').get().scope, 'setup');
});

test('direct signup is off by default and refuses an existing active account', async (t) => {
  const closed = await startApp();
  t.after(() => closed.close());
  assert.equal((await closed.client().call('POST', '/v1/signup/direct', form)).status, 403);

  const app = await startApp({ env: { ACCOUNTS_DIRECT_SIGNUP: '1' } });
  t.after(() => app.close());
  assert.equal((await app.client().call('POST', '/v1/signup/direct', form)).status, 201);
  app.db.prepare("UPDATE users SET status = 'active'").run();
  assert.deepEqual((await app.client().call('POST', '/v1/signup/direct', form)).body, { error: 'account_exists' });
});

async function addPasskey(client, id) {
  const opts = await client.call('POST', '/v1/passkeys/options', {});
  if (opts.status !== 200) return opts;
  return client.call('POST', '/v1/passkeys/verify', {
    ceremonyId: opts.body.ceremonyId,
    response: { id, challenge: opts.body.options.challenge },
  });
}

test('N2: a setup cookie kept from a direct sign-up cannot add a passkey after the victim activates', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_DIRECT_SIGNUP: '1' } });
  t.after(() => app.close());
  const attacker = app.client();
  assert.equal((await attacker.call('POST', '/v1/signup/direct', { ...form, email: 'victim@x.com' })).status, 201);
  // The victim completes sign-up through the email link and registers their passkey.
  const victim = app.client();
  await signUpAndRegister(app, victim, { email: 'victim@x.com', credentialId: 'cred-victim' });
  const userId = app.db.prepare("SELECT id FROM users WHERE email = 'victim@x.com'").pluck().get();
  // Every setup session of the account is revoked on activation, the attacker's included.
  assert.equal(app.db.prepare("SELECT COUNT(*) FROM sessions WHERE user_id = ? AND scope = 'setup' AND revoked_at IS NULL").pluck().get(userId), 0);
  const res = await addPasskey(attacker, 'cred-attacker');
  assert.equal(res.status, 401);
  assert.deepEqual(app.db.prepare('SELECT id FROM passkeys WHERE user_id = ?').pluck().all(userId), ['cred-victim']);
});

test('N2: a sign-up setup session may not add a passkey once the account is active', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const userId = insertUser(app.db, { email: 'victim@x.com', status: 'active' });
  const token = randomBytes(32).toString('base64url');
  const t0 = app.clock.now();
  app.db.prepare(
    `INSERT INTO sessions (id_hash, user_id, scope, via, created_at, last_seen_at, expires_at, auth_at)
     VALUES (?, ?, 'setup', 'signup', ?, ?, ?, ?)`,
  ).run(createHash('sha256').update(token).digest('hex'), userId, t0, t0, t0 + 60_000, t0);
  const res = await rawRequest(app.base, 'POST', '/v1/passkeys/options', '{}', {
    origin: ORIGIN, 'content-type': 'application/json', cookie: `llmide_session=${token}`,
  });
  assert.equal(res.status, 401);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM passkeys').pluck().get(), 0);
});

test('N2: direct sign-up never hands out a session for an existing pending account', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_DIRECT_SIGNUP: '1' } });
  t.after(() => app.close());
  const first = app.client();
  assert.equal((await first.call('POST', '/v1/signup/direct', form)).status, 201);
  const second = app.client();
  const res = await second.call('POST', '/v1/signup/direct', { ...form, displayName: 'Mallory' });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { status: 'add_passkey' });
  assert.equal(second.cookie, '');
  assert.equal(app.db.prepare('SELECT display_name FROM users').pluck().get(), 'Ada');
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM sessions').pluck().get(), 1);
  assert.equal((await addPasskey(second, 'cred-mallory')).status, 401);
  // The first sign-up still completes.
  assert.equal((await addPasskey(first, 'cred-ada')).status, 201);
});

test('N2: an abandoned pending account is replaced once its setup sessions have expired', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_DIRECT_SIGNUP: '1' } });
  t.after(() => app.close());
  const first = app.client();
  await first.call('POST', '/v1/signup/direct', form);
  const oldHandle = app.db.prepare('SELECT webauthn_user_id FROM users').pluck().get();
  app.clock.advance(15 * 60_000 + 1);
  const later = app.client();
  assert.equal((await later.call('POST', '/v1/signup/direct', { ...form, displayName: 'Ada L' })).status, 201);
  assert.match(later.cookie, /^llmide_session=/);
  const user = app.db.prepare('SELECT * FROM users').get();
  assert.equal(user.display_name, 'Ada L');
  assert.notDeepEqual(user.webauthn_user_id, oldHandle);
  assert.equal((await addPasskey(later, 'cred-ada')).status, 201);
});

test('N2: verifying the email link revokes setup sessions someone else opened on the pending account', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_DIRECT_SIGNUP: '1' } });
  t.after(() => app.close());
  const attacker = app.client();
  await attacker.call('POST', '/v1/signup/direct', { ...form, email: 'victim@x.com' });
  const victim = app.client();
  await victim.call('POST', '/v1/signup', { ...form, email: 'victim@x.com' });
  await victim.call('POST', '/v1/signup/verify', { token: linkToken(await waitForMail(app.mailer, 1)) });
  assert.equal((await addPasskey(attacker, 'cred-attacker')).status, 401);
  assert.equal((await addPasskey(victim, 'cred-victim')).status, 201);
  assert.deepEqual(app.db.prepare('SELECT id FROM passkeys').pluck().all(), ['cred-victim']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitForMail, linkToken, signUpAndRegister, ORIGIN } from './helpers.mjs';

async function verifiedSetupClient(app, email = 'ada@example.com') {
  const c = app.client();
  await c.call('POST', '/v1/signup', { email, displayName: 'Ada' });
  await c.call('POST', '/v1/signup/verify', { token: linkToken(await waitForMail(app.mailer, 1)) });
  return c;
}

test('registration options: resident key and user verification required, random user id, no attestation', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await verifiedSetupClient(app);
  const res = await c.call('POST', '/v1/passkeys/options', {});
  assert.equal(res.status, 200);
  assert.match(res.body.ceremonyId, /^[A-Za-z0-9_-]{22}$/);
  const [, opts] = app.webauthn.calls.find(([name]) => name === 'generateRegistrationOptions');
  assert.equal(opts.rpID, 'localhost');
  assert.equal(opts.attestationType, 'none');
  assert.deepEqual(opts.authenticatorSelection, { residentKey: 'required', userVerification: 'required' });
  assert.equal(opts.userID.length, 32);
  assert.notEqual(Buffer.from(opts.userID).toString(), 'ada@example.com');
});

test('verify from a setup session activates the account and swaps in a full session', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await verifiedSetupClient(app);
  const setupCookie = c.cookie;
  const opts = await c.call('POST', '/v1/passkeys/options', {});
  const res = await c.call('POST', '/v1/passkeys/verify', {
    ceremonyId: opts.body.ceremonyId,
    response: { id: 'cred-1', challenge: opts.body.options.challenge },
    name: 'MacBook',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { status: 'passkey_added', passkeyId: 'cred-1' });
  assert.notEqual(c.cookie, setupCookie);
  assert.equal(app.db.prepare('SELECT status FROM users').pluck().get(), 'active');
  const pk = app.db.prepare('SELECT * FROM passkeys').get();
  assert.equal(pk.name, 'MacBook');
  assert.equal(pk.counter, 0);
  const [, args] = app.webauthn.calls.find(([name]) => name === 'verifyRegistrationResponse');
  assert.equal(args.expectedOrigin, ORIGIN);
  assert.equal(args.expectedRPID, 'localhost');
  assert.equal(args.requireUserVerification, true);
  const sessions = app.db.prepare('SELECT scope, revoked_at FROM sessions ORDER BY created_at, scope').all();
  assert.equal(sessions.find((s) => s.scope === 'setup').revoked_at !== null, true);
  assert.equal(sessions.find((s) => s.scope === 'full').revoked_at, null);
});

test('wrong challenge, reused ceremony, no session and duplicate credentials are refused', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  assert.deepEqual((await app.client().call('POST', '/v1/passkeys/options', {})).body, { error: 'unauthenticated' });

  const c = await verifiedSetupClient(app);
  const opts = await c.call('POST', '/v1/passkeys/options', {});
  const bad = await c.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-1', challenge: 'other' } });
  assert.deepEqual(bad.body, { error: 'passkey_rejected' });
  const reused = await c.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-1', challenge: opts.body.options.challenge } });
  assert.deepEqual(reused.body, { error: 'ceremony_expired' });
  assert.deepEqual((await c.call('POST', '/v1/passkeys/verify', { ceremonyId: 'x', response: 'nope' })).body, { error: 'invalid_payload' });

  const other = app.client();
  await signUpAndRegister(app, other, { email: 'bob@example.com', credentialId: 'cred-bob' });
  const again = await c.call('POST', '/v1/passkeys/options', {});
  const dup = await c.call('POST', '/v1/passkeys/verify', { ceremonyId: again.body.ceremonyId, response: { id: 'cred-bob', challenge: again.body.options.challenge } });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body, { error: 'passkey_exists' });
});

test('adding a second passkey needs a fresh session and mails the user', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  await signUpAndRegister(app, c);
  const mailsBefore = app.mailer.sent.length;
  app.clock.advance(6 * 60_000);
  assert.deepEqual((await c.call('POST', '/v1/passkeys/options', {})).body, { error: 'reauth_required' });

  const fresh = app.client();
  const signin = await fresh.call('POST', '/v1/signin/options', {});
  await fresh.call('POST', '/v1/signin/verify', { ceremonyId: signin.body.ceremonyId, response: { id: 'cred-ada', challenge: signin.body.options.challenge } });
  const opts = await fresh.call('POST', '/v1/passkeys/options', {});
  const added = await fresh.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-2', challenge: opts.body.options.challenge } });
  assert.equal(added.status, 201);
  const mail = await waitForMail(app.mailer, mailsBefore + 1);
  assert.equal(mail.subject, 'A passkey was added to your LLM-IDE account');
  assert.match(mail.text, /^A new passkey was added to your account\./);
});

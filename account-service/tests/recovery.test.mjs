import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_CLIENT, DESKTOP_REDIRECT, authorize, pkcePair, rawRequest, signInDesktop, startApp, signUpAndRegister, tokenRequest, waitForMail, linkToken } from './helpers.mjs';

test('no enumeration: known and unknown addresses get the same answer; only known gets mail', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const sentBefore = app.mailer.sent.length;
  const known = await app.client().call('POST', '/v1/recovery', { email: 'ada@example.com' });
  const unknown = await app.client().call('POST', '/v1/recovery', { email: 'nobody@example.com' });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(known.body, unknown.body);
  const mail = await waitForMail(app.mailer, sentBefore + 1);
  assert.equal(mail.to, 'ada@example.com');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(app.mailer.sent.length, sentBefore + 1);
});

test('adding a passkey through the link signs out everything else and mails the user', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const oldDevice = app.client();
  await signUpAndRegister(app, oldDevice);
  app.clock.advance(60_000);

  const phone = app.client();
  const sentBefore = app.mailer.sent.length;
  await phone.call('POST', '/v1/recovery', { email: 'ada@example.com' });
  const token = linkToken(await waitForMail(app.mailer, sentBefore + 1));
  const verified = await phone.call('POST', '/v1/recovery/verify', { token });
  assert.deepEqual(verified.body, { status: 'add_passkey' });

  const opts = await phone.call('POST', '/v1/passkeys/options', {});
  const added = await phone.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-new', challenge: opts.body.options.challenge } });
  assert.equal(added.status, 201);

  // Still inside its fresh window, so only revocation explains the refusal.
  assert.deepEqual((await oldDevice.call('POST', '/v1/passkeys/options', {})).body, { error: 'unauthenticated' });
  const live = app.db.prepare('SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL').pluck().get();
  assert.equal(live, 1); // only the phone's new full session
  assert.equal(app.db.prepare('SELECT recovered_at FROM users').pluck().get(), app.clock.now());
  const notice = await waitForMail(app.mailer, sentBefore + 2);
  assert.match(notice.text, /through an email link, and every other session was signed out/);
});

test('a recovery link is not a sign-up link, works once, and unknown tokens fail', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const before = app.mailer.sent.length;
  await c.call('POST', '/v1/recovery', { email: 'ada@example.com' });
  const token = linkToken(await waitForMail(app.mailer, before + 1));
  assert.equal((await c.call('POST', '/v1/signup/verify', { token })).status, 400);
  assert.equal((await c.call('POST', '/v1/recovery/verify', { token })).status, 200);
  assert.deepEqual((await c.call('POST', '/v1/recovery/verify', { token })).body, { error: 'invalid_or_expired_link' });
  assert.equal((await c.call('POST', '/v1/recovery/verify', { token: 'A'.repeat(43) })).status, 400);
});

test('recovery verify issues a setup-scope session marked via recovery', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const before = app.mailer.sent.length;
  await c.call('POST', '/v1/recovery', { email: 'ada@example.com' });
  await c.call('POST', '/v1/recovery/verify', { token: linkToken(await waitForMail(app.mailer, before + 1)) });
  const session = app.db.prepare("SELECT scope, via FROM sessions WHERE via = 'recovery'").get();
  assert.deepEqual({ ...session }, { scope: 'setup', via: 'recovery' });
});

test('recovery signs out the desktop too: its tokens and pending sign-in codes stop working', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { web, tokens } = await signInDesktop(app);
  const pending = pkcePair();
  const auth = await authorize(app, web, { challenge: pending.challenge });
  assert.equal(auth.status, 302);
  const code = new URL(auth.headers.location).searchParams.get('code');

  const phone = app.client();
  const sentBefore = app.mailer.sent.length;
  await phone.call('POST', '/v1/recovery', { email: 'ada@example.com' });
  await phone.call('POST', '/v1/recovery/verify', { token: linkToken(await waitForMail(app.mailer, sentBefore + 1)) });
  const opts = await phone.call('POST', '/v1/passkeys/options', {});
  const added = await phone.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-new', challenge: opts.body.options.challenge } });
  assert.equal(added.status, 201);

  const profile = await rawRequest(app.base, 'GET', '/v1/desktop/account', undefined, { authorization: `Bearer ${tokens.access_token}` });
  assert.equal(profile.status, 401);
  const refresh = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: DESKTOP_CLIENT });
  assert.equal(refresh.status, 400);
  const exchange = await tokenRequest(app, { grant_type: 'authorization_code', code, redirect_uri: DESKTOP_REDIRECT, client_id: DESKTOP_CLIENT, code_verifier: pending.verifier });
  assert.equal(exchange.status, 400);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM desktop_tokens WHERE revoked_at IS NULL').pluck().get(), 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUpAndRegister } from './helpers.mjs';

async function signIn(app, client, response) {
  const opts = await client.call('POST', '/v1/signin/options', {});
  return client.call('POST', '/v1/signin/verify', { ceremonyId: opts.body.ceremonyId, response: { challenge: opts.body.options.challenge, ...response } });
}

test('discoverable sign-in: no account named, user verification required, counter stored', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const res = await signIn(app, c, { id: 'cred-ada' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'signed_in');
  assert.equal(res.body.account.email, 'ada@example.com');
  assert.equal(res.body.account.passkeys.length, 1);
  assert.equal(res.body.account.passkeys[0].publicKey, undefined);
  const [, genOpts] = app.webauthn.calls.find(([n]) => n === 'generateAuthenticationOptions');
  assert.deepEqual(genOpts.allowCredentials, []);
  assert.equal(genOpts.userVerification, 'required');
  const [, verOpts] = app.webauthn.calls.find(([n]) => n === 'verifyAuthenticationResponse');
  assert.equal(verOpts.requireUserVerification, true);
  assert.equal(verOpts.credential.id, 'cred-ada');
  const pk = app.db.prepare('SELECT counter, last_used_at FROM passkeys').get();
  assert.equal(pk.counter, 1);
  assert.equal(pk.last_used_at, app.clock.now());
});

test('every failure is the same signin_failed', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const unknown = await signIn(app, c, { id: 'cred-nobody' });
  const badSig = await signIn(app, c, { id: 'cred-ada', bad: true });
  const noCeremony = await c.call('POST', '/v1/signin/verify', { ceremonyId: 'missing', response: { id: 'cred-ada' } });
  for (const r of [unknown, badSig, noCeremony]) {
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'signin_failed' });
  }
  const failures = app.db.prepare("SELECT COUNT(*) FROM audit_events WHERE event = 'signin_failed'").pluck().get();
  assert.equal(failures, 3);
});

test('a ceremony works once', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const opts = await c.call('POST', '/v1/signin/options', {});
  const body = { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-ada', challenge: opts.body.options.challenge } };
  assert.equal((await c.call('POST', '/v1/signin/verify', body)).status, 200);
  assert.equal((await c.call('POST', '/v1/signin/verify', body)).status, 400);
});

test('signing in again rotates the session; sign-out ends it; idle sessions expire', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  await signUpAndRegister(app, c);
  const before = c.cookie;
  await signIn(app, c, { id: 'cred-ada' });
  assert.notEqual(c.cookie, before);
  const active = app.db.prepare("SELECT COUNT(*) FROM sessions WHERE scope = 'full' AND revoked_at IS NULL").pluck().get();
  assert.equal(active, 1);

  const out = await c.call('POST', '/v1/signout', {});
  assert.equal(out.status, 204);
  assert.equal(c.cookie, '');
  assert.equal(app.db.prepare("SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND scope = 'full'").pluck().get(), 0);

  await signIn(app, c, { id: 'cred-ada' });
  app.clock.advance(61 * 60_000);
  assert.deepEqual((await c.call('POST', '/v1/passkeys/options', {})).body, { error: 'unauthenticated' });
});

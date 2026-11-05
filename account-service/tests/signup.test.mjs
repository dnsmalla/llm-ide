import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitForMail, linkToken, insertUser } from './helpers.mjs';

const form = (email = 'ada@example.com') => ({ email, displayName: 'Ada', language: 'en', timeZone: 'Asia/Tokyo' });

test('sign-up is refused while closed', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_SIGNUP_OPEN: '0' } });
  t.after(() => app.close());
  const res = await app.client().call('POST', '/v1/signup', form());
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'signup_closed' });
});

test('new address: 202, a link mail, verify gives a setup session and a pending user', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  const res = await c.call('POST', '/v1/signup', form('  Ada@Example.COM '));
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { status: 'check_email' });
  const mail = await waitForMail(app.mailer, 1);
  assert.equal(mail.to, 'ada@example.com');
  const verify = await c.call('POST', '/v1/signup/verify', { token: linkToken(mail) });
  assert.equal(verify.status, 200);
  assert.deepEqual(verify.body, { status: 'add_passkey' });
  assert.match(c.cookie, /^llmide_session=/);
  const user = app.db.prepare('SELECT * FROM users').get();
  assert.equal(user.status, 'pending_passkey');
  assert.equal(user.time_zone, 'Asia/Tokyo');
  assert.equal(user.webauthn_user_id.length, 32);
  assert.equal(app.db.prepare('SELECT scope, via FROM sessions').get().scope, 'setup');
});

test('no enumeration: an existing address gets the same answer and a different mail', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  insertUser(app.db, { email: 'known@example.com' });
  const known = await app.client().call('POST', '/v1/signup', form('known@example.com'));
  const unknown = await app.client().call('POST', '/v1/signup', form('new@example.com'));
  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.body, unknown.body);
  await waitForMail(app.mailer, 2);
  const toKnown = app.mailer.sent.find((m) => m.to === 'known@example.com');
  assert.equal(toKnown.subject, 'You already have an LLM-IDE account');
  assert.doesNotMatch(toKnown.text, /token=/);
});

test('links are single use, expire after 15 minutes and the newest kills the older', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  await c.call('POST', '/v1/signup', form());
  await c.call('POST', '/v1/signup', form());
  const first = linkToken(await waitForMail(app.mailer, 1));
  const second = linkToken(await waitForMail(app.mailer, 2));
  assert.equal((await c.call('POST', '/v1/signup/verify', { token: second })).status, 200);
  assert.deepEqual((await c.call('POST', '/v1/signup/verify', { token: second })).body, { error: 'invalid_or_expired_link' });
  assert.equal((await c.call('POST', '/v1/signup/verify', { token: first })).status, 400);

  await c.call('POST', '/v1/signup', form('late@example.com'));
  const late = linkToken(await waitForMail(app.mailer, 3));
  app.clock.advance(15 * 60_000);
  assert.equal((await c.call('POST', '/v1/signup/verify', { token: late })).status, 400);
});

test('origin, content type, validation and the per-address mail cap', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  assert.deepEqual((await c.call('POST', '/v1/signup', form(), { origin: undefined })).body, { error: 'bad_origin' });
  assert.equal((await c.call('POST', '/v1/signup', form(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.call('POST', '/v1/signup', form(), { 'content-type': 'text/plain' })).status, 415);
  assert.deepEqual((await c.call('POST', '/v1/signup', form('nope'))).body, { error: 'invalid_email' });
  assert.deepEqual((await c.call('POST', '/v1/signup', { ...form(), timeZone: 'Mars/Base' })).body, { error: 'invalid_time_zone' });
  assert.deepEqual((await c.call('POST', '/v1/signup', { ...form(), displayName: '' })).body, { error: 'invalid_display_name' });
  assert.deepEqual((await c.call('POST', '/v1/signup', { ...form(), admin: true })).body, { error: 'invalid_payload' });
  for (let i = 0; i < 3; i += 1) assert.equal((await c.call('POST', '/v1/signup', form('cap@example.com'))).status, 202);
  assert.equal((await c.call('POST', '/v1/signup', form('cap@example.com'))).status, 429);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUpAndRegister, waitForMail } from './helpers.mjs';

async function signedIn(app) {
  const c = app.client();
  await signUpAndRegister(app, c);
  return c;
}

async function addPasskey(c, id) {
  const opts = await c.call('POST', '/v1/passkeys/options', {});
  return c.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id, challenge: opts.body.options.challenge } });
}

test('read and update the profile; unknown fields and bad values are refused', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  const me = await c.call('GET', '/v1/account');
  assert.equal(me.status, 200);
  assert.equal(me.body.displayName, 'Ada');
  const updated = await c.call('PATCH', '/v1/account', { displayName: 'Ada L.', language: 'ja', timeZone: 'Europe/London' });
  assert.equal(updated.status, 200);
  assert.deepEqual([updated.body.displayName, updated.body.language, updated.body.timeZone], ['Ada L.', 'ja', 'Europe/London']);
  assert.deepEqual((await c.call('PATCH', '/v1/account', { email: 'x@example.com' })).body, { error: 'invalid_payload' });
  assert.deepEqual((await c.call('PATCH', '/v1/account', { timeZone: 'Nope/Nope' })).body, { error: 'invalid_time_zone' });
  assert.equal((await c.call('PATCH', '/v1/account', { displayName: 'X' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.client().call('GET', '/v1/account')).status, 401);
});

test('remove a passkey: fresh check, never the last one, mail on removal', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  assert.deepEqual((await c.call('POST', '/v1/passkeys/remove', { id: 'cred-ada' })).body, { error: 'last_passkey' });
  assert.equal((await addPasskey(c, 'cred-2')).status, 201);
  assert.equal((await c.call('POST', '/v1/passkeys/remove', { id: 'cred-nope' })).status, 404);
  const before = app.mailer.sent.length;
  const removed = await c.call('POST', '/v1/passkeys/remove', { id: 'cred-2' });
  assert.deepEqual(removed.body, { status: 'passkey_removed' });
  assert.equal((await waitForMail(app.mailer, before + 1)).subject, 'A passkey was removed from your LLM-IDE account');
  app.clock.advance(6 * 60_000);
  assert.deepEqual((await c.call('POST', '/v1/passkeys/remove', { id: 'cred-ada' })).body, { error: 'reauth_required' });
});

test('sign out every other session', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  const other = app.client();
  const opts = await other.call('POST', '/v1/signin/options', {});
  await other.call('POST', '/v1/signin/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-ada', challenge: opts.body.options.challenge } });
  assert.deepEqual((await c.call('POST', '/v1/sessions/revoke-others', {})).body, { revoked: 1 });
  assert.equal((await other.call('GET', '/v1/account')).status, 401);
  assert.equal((await c.call('GET', '/v1/account')).status, 200);
});

test('export returns everything held about the account', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  const res = await c.call('GET', '/v1/account/export');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /attachment; filename="llm-ide-account.json"/);
  assert.equal(res.body.account.email, 'ada@example.com');
  assert.ok(res.body.sessions.length >= 1);
  assert.equal(res.body.sessions[0].id_hash, undefined);
  assert.ok(res.body.auditEvents.some((e) => e.event === 'passkey_added'));
});

test('delete: fresh check and email confirmation, then everything but the audit trail is gone', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  const userId = app.db.prepare('SELECT id FROM users').pluck().get();
  assert.deepEqual((await c.call('POST', '/v1/account/delete', { confirmEmail: 'other@example.com' })).body, { error: 'confirm_mismatch' });
  const before = app.mailer.sent.length;
  const res = await c.call('POST', '/v1/account/delete', { confirmEmail: 'Ada@Example.com' });
  assert.deepEqual(res.body, { status: 'deleted' });
  assert.equal(c.cookie, '');
  for (const table of ['users', 'passkeys', 'sessions', 'email_tokens', 'webauthn_challenges']) {
    assert.equal(app.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
  }
  assert.equal(app.db.prepare("SELECT user_id FROM audit_events WHERE event = 'account_deleted'").pluck().get(), userId);
  assert.equal((await waitForMail(app.mailer, before + 1)).subject, 'Your LLM-IDE account was deleted');
});

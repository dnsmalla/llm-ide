import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

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

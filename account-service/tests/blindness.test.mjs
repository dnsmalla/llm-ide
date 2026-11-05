import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUpAndRegister, waitForMail, linkToken } from './helpers.mjs';

// No token, cookie or link fragment issued during a full scenario may appear in the database.
test('the database never holds a token in clear', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const secrets = [];
  const web = app.client();
  await signUpAndRegister(app, web);
  secrets.push(linkToken(app.mailer.sent[0]), web.cookie.split('=')[1]);

  const phone = app.client();
  const before = app.mailer.sent.length;
  await phone.call('POST', '/v1/recovery', { email: 'ada@example.com' });
  const token = linkToken(await waitForMail(app.mailer, before + 1));
  secrets.push(token);
  await phone.call('POST', '/v1/recovery/verify', { token });
  secrets.push(phone.cookie.split('=')[1]);

  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
  const dump = tables.map((name) => JSON.stringify(app.db.prepare(`SELECT * FROM ${name}`).all())).join('\n');
  for (const secret of secrets) {
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(dump.includes(secret), false, `secret found in the database: ${secret.slice(0, 6)}…`);
  }
  assert.equal(dump.includes('token='), false);
});

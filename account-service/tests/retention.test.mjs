import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purge, IP_RETENTION_MS, PENDING_ACCOUNT_MS } from '../src/retention.mjs';
import { startApp, signUpAndRegister } from './helpers.mjs';

test('IPs are nulled after 72 hours; rows stay', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  purge(app.db, app.clock.now);
  assert.ok(app.db.prepare('SELECT COUNT(*) FROM audit_events WHERE ip IS NOT NULL').pluck().get() > 0);
  app.clock.advance(IP_RETENTION_MS + 1);
  purge(app.db, app.clock.now);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM audit_events WHERE ip IS NOT NULL').pluck().get(), 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM sessions WHERE ip IS NOT NULL').pluck().get(), 0);
  assert.ok(app.db.prepare('SELECT COUNT(*) FROM audit_events').pluck().get() > 0);
});

test('unfinished accounts go after 24 hours; active ones stay; expired tokens and sessions go', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  app.db.prepare(
    `INSERT INTO users (id, email, display_name, language, time_zone, status, webauthn_user_id, created_at, updated_at)
     VALUES ('pending', 'p@example.com', 'P', 'en', 'UTC', 'pending_passkey', randomblob(32), ?, ?)`,
  ).run(app.clock.now(), app.clock.now());
  app.clock.advance(PENDING_ACCOUNT_MS + 1);
  purge(app.db, app.clock.now);
  const emails = app.db.prepare('SELECT email FROM users ORDER BY email').pluck().all();
  assert.deepEqual(emails, ['ada@example.com']);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM email_tokens').pluck().get(), 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM sessions').pluck().get(), 0);
});

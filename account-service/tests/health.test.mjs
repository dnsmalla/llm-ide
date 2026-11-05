import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.mjs';
import { startApp, createClient } from './helpers.mjs';

test('GET /health reports the service and the sign-up state', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_SIGNUP_OPEN: '0' } });
  t.after(() => app.close());
  const res = await createClient(app.base).call('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, service: 'account-service', signupOpen: false, directSignup: false });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('unknown routes are 404 with a fixed error body', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const res = await createClient(app.base).call('GET', '/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('migrations create every table once and are idempotent', () => {
  const db = openDb(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
  for (const name of ['audit_events', 'desktop_tokens', 'devices', 'email_tokens', 'oauth_codes', 'link_requests', 'relay_wraps', 'passkeys', 'schema_migrations', 'sessions', 'users', 'webauthn_challenges']) {
    assert.ok(tables.includes(name), name);
  }
  assert.equal(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(), 6);
  db.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { createSessions, FULL_IDLE_MS, FULL_ABSOLUTE_MS, SETUP_ABSOLUTE_MS, FRESH_MS } from '../src/sessions.mjs';
import { insertUser } from './helpers.mjs';

function setup(env = {}) {
  const db = openDb(':memory:');
  insertUser(db);
  const clock = { t: 1_000_000 };
  const sessions = createSessions(db, loadConfig(env), () => clock.t);
  const reqWith = (cookie) => ({ headers: { cookie: cookie.split(';')[0] } });
  return { db, clock, sessions, reqWith };
}

test('HTTPS cookies use the __Host- prefix, Secure, HttpOnly and SameSite=Strict', () => {
  const { sessions } = setup({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_MAIL_TRANSPORT: 'file' });
  const { cookie } = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: '203.0.113.9' });
  assert.match(cookie, /^__Host-llmide_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200$/);
  assert.match(sessions.clearCookie(), /^__Host-llmide_session=; .*Max-Age=0$/);
});

test('only the token hash is stored', () => {
  const { db, sessions } = setup();
  const { cookie } = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  const token = cookie.split(';')[0].split('=')[1];
  const row = db.prepare('SELECT id_hash FROM sessions').get();
  assert.notEqual(row.id_hash, token);
  assert.match(row.id_hash, /^[0-9a-f]{64}$/);
});

test('full sessions expire after 1 h idle and 12 h absolute', () => {
  const { clock, sessions, reqWith } = setup();
  const { cookie } = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  // Twelve touches just inside the idle window: 12 h - 12 ms, still under the absolute limit.
  for (let i = 0; i < 12; i += 1) {
    clock.t += FULL_IDLE_MS - 1;
    assert.ok(sessions.read(reqWith(cookie)), `alive after touch ${i + 1}`);
  }
  assert.equal(FULL_ABSOLUTE_MS, 12 * FULL_IDLE_MS);
  clock.t += FULL_IDLE_MS - 1; // within idle, past the 12 h absolute limit
  assert.equal(sessions.read(reqWith(cookie)), null);

  const second = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  clock.t += FULL_IDLE_MS + 1;
  assert.equal(sessions.read(reqWith(second.cookie)), null);
});

test('setup sessions last 15 minutes and are refused where a full session is required', () => {
  const { clock, sessions, reqWith } = setup();
  const { cookie } = sessions.create({ userId: 'user-1', scope: 'setup', via: 'signup', ip: null });
  assert.throws(() => sessions.require(reqWith(cookie)), (e) => e.status === 401 && e.code === 'unauthenticated');
  assert.equal(sessions.require(reqWith(cookie), ['setup']).scope, 'setup');
  clock.t += SETUP_ABSOLUTE_MS;
  assert.equal(sessions.read(reqWith(cookie)), null);
});

test('fresh check, revoke and revokeOthers', () => {
  const { clock, sessions, reqWith } = setup();
  const a = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  const b = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  const sa = sessions.read(reqWith(a.cookie));
  sessions.requireFresh(sa);
  clock.t += FRESH_MS + 1;
  assert.throws(() => sessions.requireFresh(sessions.read(reqWith(a.cookie))), (e) => e.code === 'reauth_required');
  assert.equal(sessions.revokeOthers('user-1', a.idHash), 1);
  assert.equal(sessions.read(reqWith(b.cookie)), null);
  assert.ok(sessions.read(reqWith(a.cookie)));
  sessions.revoke(a.idHash);
  assert.equal(sessions.read(reqWith(a.cookie)), null);
});

test('garbage cookies are ignored', () => {
  const { sessions } = setup();
  assert.equal(sessions.read({ headers: {} }), null);
  assert.equal(sessions.read({ headers: { cookie: 'llmide_session=../../etc' } }), null);
});

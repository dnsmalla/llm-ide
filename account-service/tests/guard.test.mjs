import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { HttpError } from '../src/http.mjs';
import { checkOrigin, clientIp } from '../src/guard.mjs';
import { createRateLimiter, limitMailTo, HOUR } from '../src/rate-limit.mjs';
import { createAudit } from '../src/audit.mjs';

const fakeReq = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('clientIp trusts X-Real-IP only behind a loopback proxy with trustProxy on', () => {
  const off = loadConfig({});
  const on = loadConfig({ ACCOUNTS_TRUST_PROXY: '1' });
  assert.equal(clientIp(fakeReq('127.0.0.1', { 'x-real-ip': '203.0.113.9' }), off), '127.0.0.1');
  assert.equal(clientIp(fakeReq('127.0.0.1', { 'x-real-ip': '203.0.113.9' }), on), '203.0.113.9');
  assert.equal(clientIp(fakeReq('198.51.100.7', { 'x-real-ip': '203.0.113.9' }), on), '198.51.100.7');
});

test('checkOrigin requires the exact service origin', () => {
  const config = loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_MAIL_TRANSPORT: 'file' });
  checkOrigin({ headers: { origin: 'https://accounts.llm-ide.com' } }, config);
  for (const origin of [undefined, 'null', 'https://evil.example', 'https://accounts.llm-ide.com.evil.example']) {
    assert.throws(() => checkOrigin({ headers: { origin } }, config), (e) => e instanceof HttpError && e.status === 403 && e.code === 'bad_origin');
  }
});

test('rate limiter trips past the limit and resets after the window', () => {
  let t = 0;
  const limiter = createRateLimiter({ now: () => t });
  for (let i = 0; i < 3; i += 1) limiter.hit('k', 3, 1000);
  assert.throws(() => limiter.hit('k', 3, 1000), (e) => e.status === 429 && e.headers['retry-after'] === '1');
  t = 1000;
  limiter.hit('k', 3, 1000);
});

test('limitMailTo allows 3 mails per address per hour and 10 per day', () => {
  let t = 0;
  const limiter = createRateLimiter({ now: () => t });
  let sent = 0;
  for (let hour = 0; hour < 5; hour += 1) {
    t = hour * HOUR;
    for (let i = 0; i < 3; i += 1) {
      try { limitMailTo(limiter, 'a@example.com'); sent += 1; } catch (e) { assert.equal(e.status, 429); }
    }
  }
  assert.equal(sent, 10);
});

test('audit writes one row per event with JSON detail', () => {
  const db = openDb(':memory:');
  const audit = createAudit(db, () => 42);
  audit('signin', { userId: 'u1', ip: '203.0.113.9', detail: { passkeyId: 'p1' } });
  const row = db.prepare('SELECT at, user_id, event, ip, detail FROM audit_events').get();
  assert.deepEqual({ ...row }, { at: 42, user_id: 'u1', event: 'signin', ip: '203.0.113.9', detail: '{"passkeyId":"p1"}' });
  db.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('defaults: loopback, sign-up closed, file mailer in development', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 3470);
  assert.equal(c.signupOpen, false);
  assert.equal(c.mail.transport, 'file');
  assert.equal(c.rpId, 'localhost');
  assert.equal(c.secureCookies, false);
});

test('sign-up opens only with ACCOUNTS_SIGNUP_OPEN=1', () => {
  assert.equal(loadConfig({ ACCOUNTS_SIGNUP_OPEN: '1' }).signupOpen, true);
  assert.equal(loadConfig({ ACCOUNTS_SIGNUP_OPEN: '0' }).signupOpen, false);
});

test('production requires https, smtps and never the file mailer', () => {
  const prod = { NODE_ENV: 'production', ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_SMTP_URL: 'smtps://u:p@smtp.example.com:465' };
  const c = loadConfig(prod);
  assert.equal(c.rpId, 'accounts.llm-ide.com');
  assert.equal(c.secureCookies, true);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_ORIGIN: 'http://accounts.llm-ide.com' }), /https/);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_MAIL_TRANSPORT: 'file' }), /file mailer/);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_SMTP_URL: 'smtp://smtp.example.com' }), /smtps/);
});

test('refuses a non-loopback bind, a non-bare origin and a foreign RP ID', () => {
  assert.throws(() => loadConfig({ ACCOUNTS_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com/x' }), /bare origin/);
  assert.throws(() => loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_RP_ID: 'evil.com' }), /RP_ID/);
  assert.throws(() => loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_RP_ID: 'llm-ide.com' }), /RP_ID/);
});

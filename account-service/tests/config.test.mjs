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

test('ADR 0020: production refuses to start the retired service and relay without the explicit override', () => {
  const env = { NODE_ENV: 'production', ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_MAIL_TRANSPORT: 'none' };
  assert.throws(() => loadConfig(env), /retired/);
  assert.throws(() => loadConfig({ ...env, ACCOUNTS_RELAY: '1' }), /retired/);
  assert.equal(loadConfig({ ...env, ACCOUNTS_ALLOW_RETIRED: '1' }).relay.enabled, false);
});

test('production requires https, smtps and never the file mailer', () => {
  const prod = { NODE_ENV: 'production', ACCOUNTS_ALLOW_RETIRED: '1', ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_SMTP_URL: 'smtps://u:p@smtp.example.com:465' };
  const c = loadConfig(prod);
  assert.equal(c.rpId, 'accounts.llm-ide.com');
  assert.equal(c.secureCookies, true);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_ORIGIN: 'http://accounts.llm-ide.com' }), /https/);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_MAIL_TRANSPORT: 'file' }), /file mailer/);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_SMTP_URL: 'smtp://smtp.example.com' }), /smtps/);
  assert.equal(loadConfig({ ...prod, ACCOUNTS_MAIL_TRANSPORT: 'none' }).mail.transport, 'none');
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_MAIL_TRANSPORT: 'none', ACCOUNTS_SIGNUP_OPEN: '1' }), /without a mail transport/);
});

test('refuses a non-loopback bind, a non-bare origin and a foreign RP ID', () => {
  assert.throws(() => loadConfig({ ACCOUNTS_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com/x' }), /bare origin/);
  assert.throws(() => loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_RP_ID: 'evil.com' }), /RP_ID/);
  assert.throws(() => loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_RP_ID: 'llm-ide.com' }), /RP_ID/);
});

test('N1: direct sign-up outside localhost needs an allowlist of exact addresses', () => {
  const prod = { NODE_ENV: 'production', ACCOUNTS_ALLOW_RETIRED: '1', ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_MAIL_TRANSPORT: 'none', ACCOUNTS_DIRECT_SIGNUP: '1' };
  assert.throws(() => loadConfig(prod), /ACCOUNTS_DIRECT_SIGNUP_EMAILS/);
  assert.throws(() => loadConfig({ ACCOUNTS_ORIGIN: 'http://accounts.example.com', ACCOUNTS_DIRECT_SIGNUP: '1' }), /ACCOUNTS_DIRECT_SIGNUP_EMAILS/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', ACCOUNTS_ALLOW_RETIRED: '1', ACCOUNTS_ORIGIN: 'https://localhost', ACCOUNTS_MAIL_TRANSPORT: 'none', ACCOUNTS_DIRECT_SIGNUP: '1' }), /ACCOUNTS_DIRECT_SIGNUP_EMAILS/);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_DIRECT_SIGNUP_EMAILS: 'not-an-address' }), /ACCOUNTS_DIRECT_SIGNUP_EMAILS/);
  const c = loadConfig({ ...prod, ACCOUNTS_DIRECT_SIGNUP_EMAILS: ' Ada@Example.com, bob@example.com ' });
  assert.equal(c.directSignup, true);
  assert.deepEqual([...c.directSignupEmails], ['ada@example.com', 'bob@example.com']);
  // Localhost development may run without a list (open to any address).
  assert.equal(loadConfig({ ACCOUNTS_DIRECT_SIGNUP: '1' }).directSignupEmails, null);
  assert.equal(loadConfig({ ...prod, ACCOUNTS_DIRECT_SIGNUP: '0' }).directSignup, false);
});

test('relay is off by default and its web origins are exact https origins, never the accounts origin', () => {
  const base = { ACCOUNTS_ORIGIN: 'https://accounts.example.com', NODE_ENV: 'production', ACCOUNTS_ALLOW_RETIRED: '1', ACCOUNTS_MAIL_TRANSPORT: 'none' };
  assert.equal(loadConfig(base).relay.enabled, false);
  const on = loadConfig({ ...base, ACCOUNTS_RELAY: '1', ACCOUNTS_ALLOWED_WEB_ORIGINS: 'https://app.example.com' });
  assert.equal(on.relay.enabled, true);
  assert.deepEqual([...on.relay.webOrigins], ['https://app.example.com']);
  assert.throws(() => loadConfig({ ...base, ACCOUNTS_ALLOWED_WEB_ORIGINS: 'http://app.example.com' }), /https/);
  assert.throws(() => loadConfig({ ...base, ACCOUNTS_ALLOWED_WEB_ORIGINS: 'https://app.example.com/path' }), /bare origins/);
  assert.throws(() => loadConfig({ ...base, ACCOUNTS_ALLOWED_WEB_ORIGINS: 'https://accounts.example.com' }), /own origin/);
});

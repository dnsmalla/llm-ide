// AGT-1: SSRF guard on custom provider base URLs.
// TDD: these tests were written first; they drove the implementation of
// assertSafeBaseUrl() in extension/agents/providers.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Must be set before importing anything that touches vault/db.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { assertSafeBaseUrl, minimalCliEnv } = await import('../agents/providers.mjs');

// ── assertSafeBaseUrl: URLs that MUST pass ────────────────────────────

test('AGT-1: public HTTPS FQDN passes', () => {
  assert.doesNotThrow(() => assertSafeBaseUrl('https://api.openai.com/v1'));
  assert.doesNotThrow(() => assertSafeBaseUrl('https://openrouter.ai/api/v1'));
  assert.doesNotThrow(() => assertSafeBaseUrl('https://api.deepseek.com/v1'));
});

// ── assertSafeBaseUrl: URLs that MUST be rejected ────────────────────

test('AGT-1: http:// scheme is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('http://api.openai.com/v1'), /https/i);
});

test('AGT-1: localhost is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://localhost/v1'), /localhost/i);
});

test('AGT-1: 127.0.0.1 loopback is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://127.0.0.1/v1'), /private|loopback/i);
});

test('AGT-1: 127.x.y.z range is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://127.100.200.50/v1'), /private|loopback/i);
});

test('AGT-1: 169.254.169.254 link-local (AWS metadata) is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://169.254.169.254/latest/meta-data'), /private|loopback/i);
});

test('AGT-1: 10.0.0.1 RFC-1918 is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://10.0.0.1/v1'), /private|loopback/i);
});

test('AGT-1: 192.168.1.1 RFC-1918 is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://192.168.1.1/v1'), /private|loopback/i);
});

test('AGT-1: 172.16.0.1 RFC-1918 is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://172.16.0.1/v1'), /private|loopback/i);
});

test('AGT-1: 172.31.255.255 RFC-1918 upper bound is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://172.31.255.255/v1'), /private|loopback/i);
});

test('AGT-1: IPv6 loopback ::1 is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://[::1]/v1'), /private|loopback/i);
});

test('AGT-1: IPv6 link-local fe80:: is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('https://[fe80::1]/v1'), /private|loopback/i);
});

test('AGT-1: completely invalid URL is rejected', () => {
  assert.throws(() => assertSafeBaseUrl('not-a-url'), /invalid base URL/i);
});

// ── AGT-4: minimalCliEnv allowlist ───────────────────────────────────

test('AGT-4: minimalCliEnv includes PATH', () => {
  const env = minimalCliEnv();
  assert.ok('PATH' in env || Object.keys(env).length === 0,
    'PATH should be present when process.env.PATH is set (or env is empty when nothing is set)');
  // When PATH is set in the test process, it must appear.
  if (process.env.PATH) assert.equal(env.PATH, process.env.PATH);
});

test('AGT-4: minimalCliEnv excludes LLMIDE_JWT_SECRET', () => {
  process.env.LLMIDE_JWT_SECRET = 'supersecret-jwt';
  const env = minimalCliEnv();
  assert.ok(!('LLMIDE_JWT_SECRET' in env), 'JWT secret must not leak to CLI subprocesses');
});

test('AGT-4: minimalCliEnv excludes LLMIDE_VAULT_KEY', () => {
  process.env.LLMIDE_VAULT_KEY = 'supersecret-vault';
  const env = minimalCliEnv();
  assert.ok(!('LLMIDE_VAULT_KEY' in env), 'Vault key must not leak to CLI subprocesses');
});

test('AGT-4: minimalCliEnv merges extra keys', () => {
  const env = minimalCliEnv({ OPENAI_API_KEY: 'sk-test' });
  assert.equal(env.OPENAI_API_KEY, 'sk-test');
  assert.ok(!('LLMIDE_VAULT_KEY' in env));
});

test('AGT-4: minimalCliEnv strips empty-string entries', () => {
  const env = minimalCliEnv({ SOME_EMPTY: '' });
  assert.ok(!('SOME_EMPTY' in env), 'empty-string keys should be stripped');
});

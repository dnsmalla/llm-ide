// Tests for the shared secret-redaction module (core/redact-secrets.mjs) and
// its use in the audit log. Previously the sk-ant / token patterns were
// copy-pasted across outcome-watcher / runtime / github-pr with divergent
// regexes, and audit.mjs redacted only by KEY NAME — so a secret value stored
// under a non-credential key (e.g. an error `message`) was written to the
// audit log in plaintext. These tests pin: (1) one canonical pattern set, and
// (2) that the audit redactor scrubs secret VALUES, not just secret key names.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets, redactWithKey } from '../core/redact-secrets.mjs';
import { redact as auditRedact } from '../server/audit.mjs';

test('redactSecrets scrubs every known token shape', () => {
  const cases = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'sk-' + 'a'.repeat(48),                      // OpenAI classic secret key
    'sk-proj-' + 'b'.repeat(40),                 // OpenAI project-scoped key
    'ghp_' + 'a'.repeat(36),                     // GitHub classic PAT
    'gho_' + 'a'.repeat(36),                     // GitHub OAuth token
    'ghu_' + 'a'.repeat(36),                     // GitHub user-to-server
    'ghs_' + 'a'.repeat(36),                     // GitHub server-to-server
    'ghr_' + 'a'.repeat(36),                     // GitHub refresh token
    'github_pat_' + 'b'.repeat(82),
    'glpat-' + 'a'.repeat(20),                   // GitLab personal access token
    'glrt-' + 'b'.repeat(24),                    // GitLab runner token
    'gldt-' + 'c'.repeat(24),                    // GitLab deploy token
    'xoxb-0123456789abcdef',
    'AIza' + 'c'.repeat(35),
    'AKIA' + 'A'.repeat(16),
    'Bearer abcdefghijklmnopqrstuvwxyz',
    'apiKey=supersecretvalue',
  ];
  for (const raw of cases) {
    const out = redactSecrets(`prefix ${raw} suffix`);
    assert.ok(out.includes('[REDACTED]'), `expected redaction marker for: ${raw}`);
    assert.ok(!out.includes(raw), `raw secret should not survive: ${raw} -> ${out}`);
  }
});

test('redactSecrets leaves ordinary text intact', () => {
  const msg = 'Bad request: the model name is invalid, check LLMIDE_MODEL.';
  assert.equal(redactSecrets(msg), msg);
});

test('redactSecrets coerces non-strings without throwing', () => {
  assert.equal(typeof redactSecrets(undefined), 'string');
  assert.equal(typeof redactSecrets({ a: 1 }), 'string');
});

test('redactWithKey masks the exact in-flight key, even an unrecognized shape', () => {
  // A custom-provider key the shared patterns don't match must still be masked
  // because we pass the exact key.
  const key = 'custom-opaque-credential-1234567890';
  const body = `401 Unauthorized: invalid key ${key}`;
  const out = redactWithKey(body, key);
  assert.ok(!out.includes(key), 'exact key must be removed');
  assert.ok(out.includes('[REDACTED]'));
});

test('redactWithKey also scrubs OTHER token shapes the body echoes back', () => {
  // Even with a different in-flight key, a foreign token in the body (e.g. a
  // GitHub PAT echoed by a misconfigured proxy) is caught by the shared patterns.
  const out = redactWithKey('leaked ghp_123456789012345678901234567890123456', 'sk-ant-inflight');
  assert.ok(!out.includes('ghp_123456789012345678901234567890123456'));
  assert.ok(out.includes('[REDACTED]'));
});

test('redactWithKey tolerates a missing/short key and non-string input', () => {
  assert.equal(redactWithKey('plain text', undefined), 'plain text');
  assert.equal(redactWithKey('plain text', 'abc'), 'plain text'); // <8 chars: skip exact mask
  assert.equal(typeof redactWithKey(undefined, undefined), 'string');
});

test('audit redact scrubs a secret VALUE under a non-credential key', () => {
  // The leak: an sk-ant key embedded in a free-text field whose key name is
  // not in REDACT_KEYS (here `message`) was previously stored verbatim.
  const detail = { message: 'Anthropic rejected request: bad x-api-key sk-ant-api03-abcdefghijklmnop' };
  const out = auditRedact(detail);
  assert.ok(!out.message.includes('sk-ant-api03'), `value-embedded key must be redacted; got: ${out.message}`);
  assert.ok(out.message.includes('[REDACTED]'), 'redaction marker should appear in the value');
  // Surrounding context is preserved (only the token is scrubbed).
  assert.ok(out.message.startsWith('Anthropic rejected request'), 'non-secret context preserved');
});

test('audit redact still redacts by key name', () => {
  const out = auditRedact({ password: 'hunter2', refreshToken: 'abc', nested: { apiKey: 'xyz' } });
  assert.equal(out.password, '[redacted]');
  assert.equal(out.refreshToken, '[redacted]');
  assert.equal(out.nested.apiKey, '[redacted]');
});

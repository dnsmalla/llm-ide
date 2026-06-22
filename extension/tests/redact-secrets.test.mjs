// Tests for the shared secret-redaction module (core/redact-secrets.mjs) and
// its use in the audit log. Previously the sk-ant / token patterns were
// copy-pasted across outcome-watcher / runtime / github-pr with divergent
// regexes, and audit.mjs redacted only by KEY NAME — so a secret value stored
// under a non-credential key (e.g. an error `message`) was written to the
// audit log in plaintext. These tests pin: (1) one canonical pattern set, and
// (2) that the audit redactor scrubs secret VALUES, not just secret key names.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets } from '../core/redact-secrets.mjs';
import { redact as auditRedact } from '../server/audit.mjs';

test('redactSecrets scrubs every known token shape', () => {
  const cases = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'ghp_' + 'a'.repeat(36),
    'github_pat_' + 'b'.repeat(82),
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

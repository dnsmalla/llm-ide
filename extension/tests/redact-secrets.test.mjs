// Tests for the shared secret-redaction module (core/redact-secrets.mjs) and
// its use in the audit log. Previously the sk-ant / token patterns were
// copy-pasted across outcome-watcher / runtime / github-pr with divergent
// regexes, and audit.mjs redacted only by KEY NAME — so a secret value stored
// under a non-credential key (e.g. an error `message`) was written to the
// audit log in plaintext. These tests pin: (1) one canonical pattern set, and
// (2) that the audit redactor scrubs secret VALUES, not just secret key names.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  redactSecrets, redactWithKey, redactSecretsForStorage, hasSecretShape,
} from '../core/redact-secrets.mjs';
import { redact as auditRedact } from '../core/redact-object.mjs';

// ---- storage-time redaction (kb/meetings.mjs, kb/chat-sessions.mjs) ------

test('redactSecretsForStorage: a plainly written key is replaced in place', () => {
  const key = 'AKIA' + 'Q'.repeat(16);
  assert.equal(redactSecretsForStorage(`the key is ${key} ok`), 'the key is [REDACTED] ok');
});

test('redactSecretsForStorage: a key laced with zero-width characters is caught, separators included', () => {
  const laced = 'AKIA' + 'Q'.repeat(8) + '\u200B' + 'Q'.repeat(4) + '\u200D' + 'Q'.repeat(4);
  const out = redactSecretsForStorage(`the key is ${laced} ok`);
  assert.equal(out, 'the key is [REDACTED] ok');
  assert.equal(hasSecretShape(out), false);
});

test('redactSecretsForStorage: a fixed-length key wrapped across a caption line break is caught whole', () => {
  const wrapped = 'ghp_' + 'a'.repeat(18) + '\n' + 'a'.repeat(18);
  // The next caption line starts right after the wrap — collapsing whitespace
  // glues "Alice" onto the token, which is exactly what used to hide it.
  const out = redactSecretsForStorage(`Bob: the PAT is ${wrapped}\nAlice: rotate quarterly`);
  assert.equal(out, 'Bob: the PAT is [REDACTED]\nAlice: rotate quarterly');
  assert.equal(hasSecretShape(out), false);
  const aws = 'AKIA' + 'Q'.repeat(9) + '\n' + 'Q'.repeat(7);
  assert.equal(redactSecretsForStorage(`key ${aws} end`), 'key [REDACTED] end');
});

test('redactSecretsForStorage: an open-ended key wrapped across a line is redacted to its minimum length (documented limit)', () => {
  // sk-ant- bodies are {10,}: the plain view matches the first line's 10+
  // chars; the tail past the wrap survives. Bridging whitespace for an
  // open-ended shape would let the match swallow the words that follow, so
  // this is the accepted trade-off. What must hold: the prefix is gone and
  // the neighbouring words are intact.
  const out = redactSecretsForStorage('Alice: it is sk-ant-api03-abcdefghij\nklmnopqrstuvwxyz — write it down');
  assert.equal(out, 'Alice: it is [REDACTED]\nklmnopqrstuvwxyz — write it down');
});

test('redactSecretsForStorage: a Bearer token with an embedded zero-width char is caught by the ZW-only pass', () => {
  // Whitespace-collapsing alone would destroy the `Bearer\s+` shape, so the
  // zero-width-only view has to run first.
  const out = redactSecretsForStorage('Authorization: Bearer abc\u200Bdefghijklmnopqrstuvwxyz');
  assert.ok(out.includes('[REDACTED]'), out);
  assert.equal(hasSecretShape(out), false);
});

test('redactSecretsForStorage: legitimate zero-width joiners and ordinary text are untouched', () => {
  const family = 'Team lunch \u{1F468}\u200D\u{1F469}\u200D\u{1F467} at noon; ZWNJ in می\u200Cخواهم stays';
  assert.equal(redactSecretsForStorage(family), family);
  assert.equal(hasSecretShape(family), false);
  const notes = 'Decision: rotate keys quarterly. Owner: Bob. Deadline 2026-10-01.';
  assert.equal(redactSecretsForStorage(notes), notes);
});

test('redactSecretsForStorage: two keys, one plain and one laced, both redacted', () => {
  const plain = 'ghp_' + 'a'.repeat(36);
  const laced = 'xoxb-' + '1'.repeat(6) + '\u2060' + '1'.repeat(6);
  const out = redactSecretsForStorage(`${plain} and ${laced}`);
  assert.equal(out, '[REDACTED] and [REDACTED]');
});

test('redactSecretsForStorage: soft hyphen, bidi controls and variation selectors do not hide a token', () => {
  // U+00AD is invisible in every renderer and survives copy/paste; it is Cf
  // but was not in the original hand-listed five.
  const softHyphen = 'ghp_' + 'a'.repeat(18) + '\u00AD' + 'a'.repeat(18);
  assert.equal(redactSecretsForStorage(`PAT ${softHyphen} end`), 'PAT [REDACTED] end');
  const bidi = 'sk-ant-api03-abcdef\u202Eghijklmnop';
  assert.equal(redactSecretsForStorage(`k ${bidi} end`), 'k [REDACTED] end');
  const vs16 = 'AKIA' + 'Q'.repeat(8) + '\uFE0F' + 'Q'.repeat(8);
  assert.equal(redactSecretsForStorage(`k ${vs16} end`), 'k [REDACTED] end');
  const accent = 'AKIA' + 'Q'.repeat(8) + '\u0301' + 'Q'.repeat(8);
  assert.equal(redactSecretsForStorage(`k ${accent} end`), 'k [REDACTED] end');
  // NBSP and ideographic space are `\s` in JS — wrapped fixed-length tokens
  // across them are caught too.
  const nbsp = 'AKIA' + 'Q'.repeat(8) + '\u00A0' + 'Q'.repeat(8);
  assert.equal(redactSecretsForStorage(`k ${nbsp} end`), 'k [REDACTED] end');
});

test('redactSecretsForStorage: `apiKey=` prose is documentation, not a credential', () => {
  const doc = 'set apiKey=true in config, then apiKey=YOUR_KEY as shown';
  assert.equal(redactSecretsForStorage(doc), doc);
  assert.equal(redactSecretsForStorage('url?apiKey=' + 'k'.repeat(24) + '&x=1'), 'url?[REDACTED]&x=1');
  // The error-body redactor keeps the broad shape — that is its job.
  assert.equal(redactSecrets('apiKey=true'), '[REDACTED]');
});

test('redactSecretsForStorage: blank-rendering letters (Hangul fillers, braille blank) do not hide a fixed-length token', () => {
  // Category Lo, so no \\s / Cf / Mn class reaches them; they are listed by hand.
  for (const blank of ['\u115F', '\u1160', '\u3164', '\uFFA0', '\u2800', '\u0000']) {
    const pat = 'ghp_' + 'a'.repeat(18) + blank + 'a'.repeat(18);
    assert.equal(redactSecretsForStorage(`PAT ${pat} end`), 'PAT [REDACTED] end', `U+${blank.codePointAt(0).toString(16)}`);
  }
  // Real Hangul text next to an identifier is untouched.
  const ko = '회의 메모: ghp_ 토큰을 교체합니다';
  assert.equal(redactSecretsForStorage(ko), ko);
});

test('hasSecretShape is stateless across calls (no global-regex lastIndex carry-over)', () => {
  const key = 'AKIA' + 'Q'.repeat(16);
  assert.equal(hasSecretShape(key), true);
  assert.equal(hasSecretShape(key), true);
  assert.equal(hasSecretShape(key), true);
  assert.equal(hasSecretShape(''), false);
  assert.equal(hasSecretShape(null), false);
});

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

test('redactSecrets scrubs Google OAuth2 access and refresh tokens', () => {
  const cases = [
    'ya29.a0AfH-EXAMPLE_ACCESS_TOKEN_abcdefghijklmnop',
    '1//0gEXAMPLE_REFRESH_TOKEN_abcdefghijklmnop',
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

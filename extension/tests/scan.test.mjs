// Tests for guardrails/scan.mjs — the lightweight secret-detection
// function used to guard KB ingest of LLM-generated content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForSecrets } from '../guardrails/scan.mjs';

// ── should detect ─────────────────────────────────────────────────────────────

test('detects a GitHub PAT', () => {
  assert.equal(
    scanForSecrets('token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    true,
  );
});

test('detects an AWS access key', () => {
  assert.equal(scanForSecrets('key=AKIAIOSFODNN7EXAMPLE rest'), true);
});

test('detects a Slack token', () => {
  assert.equal(scanForSecrets('xoxb-111-222-abcdefghij here'), true);
});

test('detects a PEM private key header', () => {
  assert.equal(scanForSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), true);
});

test('detects a generic api_key assignment', () => {
  assert.equal(scanForSecrets('api_key = "abc1234567890abcdef"'), true);
});

test('detects a Bearer token in an Authorization header', () => {
  assert.equal(scanForSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xxxxx'), true);
});

test('detects a line-wrapped GitHub PAT (collapsed match)', () => {
  // Split the token across lines — collapsed variant must catch it.
  // ghp_ (4) + 16 a's + newline + 20 a's = exactly 36 chars after ghp_.
  // The \b at the end of the regex succeeds because the collapsed string
  // ends there (end-of-string is a word boundary).
  const wrapped = 'ghp_aaaaaaaaaaaaaaaa\naaaaaaaaaaaaaaaaaaaa'; // 16 + 20 = 36
  assert.equal(scanForSecrets(wrapped), true);
});

// ── should NOT detect ─────────────────────────────────────────────────────────

test('returns false for clean meeting notes', () => {
  const notes = `## Meeting Summary\n
- Discussed Q3 roadmap
- Alice will follow up on the design doc
- Next meeting: Thursday 14:00`;
  assert.equal(scanForSecrets(notes), false);
});

test('returns false for empty string', () => {
  assert.equal(scanForSecrets(''), false);
});

test('returns false for null / non-string input', () => {
  assert.equal(scanForSecrets(null), false);
  assert.equal(scanForSecrets(undefined), false);
  assert.equal(scanForSecrets(42), false);
});

test('returns false for a URL that is not a token', () => {
  assert.equal(scanForSecrets('https://example.com/api/v2/issues'), false);
});

// AGT-5: zero-width chars must not allow evasion of secret detection.
// U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ), U+2060 (word-joiner),
// and U+FEFF (BOM/ZWNBSP) are invisible and not matched by \s, so an
// attacker can embed them inside a secret to defeat the \s+ collapse.
test('detects AWS key split by U+200B zero-width space (AGT-5)', () => {
  // AKIAIOSFODNN7EXAMPLE — 20 chars. Insert a U+200B after "AKIA" so the
  // raw text fails the \bAKIA…\b match, and the \s+-only collapse also
  // fails (U+200B is NOT \s in JS regex).
  const evaded = 'AKIA​IOSFODNN7EXAMPLE';
  assert.equal(scanForSecrets(evaded), true,
    'zero-width U+200B embedded in AWS key must be detected');
});

test('detects GitHub PAT split by U+200D ZWJ (AGT-5)', () => {
  // ghp_ + 36 alphanumeric chars — split in the middle with U+200D.
  const evaded = 'ghp_aaaaaaaaaaaa‍aaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(scanForSecrets(evaded), true,
    'zero-width U+200D embedded in GitHub PAT must be detected');
});

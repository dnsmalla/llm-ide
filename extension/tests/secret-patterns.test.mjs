// R-036 A6: ONE credential-shape list in core, imported by the redactor, the guardrails and the Factory Ship
// pre-push scan. Positive cases prove all three see a shape; near misses prove the shapes stay specific.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECRET_SHAPES } from '../core/secret-patterns.mjs';
import { redactSecrets, hasSecretShape } from '../core/redact-secrets.mjs';
import { SECRET_PATTERNS } from '../guardrails/rules.mjs';
import { scanForSecrets as guardScan } from '../guardrails/scan.mjs';
import { scanForSecrets as shipScan } from '../agents/github-pr.mjs';

test('the redactor and the guardrails use the exact core list, not a copy', () => {
  assert.equal(SECRET_PATTERNS, SECRET_SHAPES);
  const github = readFileSync(new URL('../agents/github-pr.mjs', import.meta.url), 'utf8');
  const rules = readFileSync(new URL('../guardrails/rules.mjs', import.meta.url), 'utf8');
  assert.match(github, /from '\.\.\/core\/secret-patterns\.mjs'/);
  assert.match(rules, /from '\.\.\/core\/secret-patterns\.mjs'/);
  assert.doesNotMatch(github, /const SECRET_RULES = \[/, 'no local copy in the Ship scan');
  assert.doesNotMatch(rules, /export const SECRET_PATTERNS = \[/, 'no local copy in the guardrails');
});

test('every shared shape is non-global, so .test() never carries lastIndex between lines', () => {
  for (const { name, re } of SECRET_SHAPES) assert.equal(re.global, false, name);
  // Open-ended lengths: a longer token must never slip past the last pre-push gate.
  assert.equal(shipScan(`+const k = "ghp_${'a'.repeat(40)}"`), 'GitHub token');
  assert.equal(shipScan(`+const k = "ghs_${'b'.repeat(60)}"`), 'GitHub token');
  assert.equal(shipScan(`+const k = "github_pat_${'c'.repeat(90)}"`), 'GitHub token');
  assert.equal(shipScan(`+const k = "npm_${'d'.repeat(40)}"`), 'npm token');
  const aws = `aws_secret_access_key = "${'a1'.repeat(20)}"`;
  assert.equal(shipScan(`+const url = "https://example.com/x"\n+${aws}`), 'AWS secret access key');
});

const POSITIVE = [
  { name: 'GitHub token', value: `github_pat_${'A1'.repeat(41)}` },
  { name: 'Stripe live key', value: `sk_live_${'a1'.repeat(12)}` },
  { name: 'Stripe live key', value: `rk_live_${'b2'.repeat(12)}` },
  { name: 'npm token', value: `npm_${'c3'.repeat(18)}` },
  { name: 'Slack webhook URL', value: `https://hooks.slack.com/services/${'T0/B0'}/${'x9'.repeat(10)}` },
  { name: 'URL with credentials', value: `postgres://alice:s3cret@db.example.com/app` },
];

test('every new shape is caught by redaction, the guardrails and the Ship scan', () => {
  for (const { name, value } of POSITIVE) {
    const redacted = redactSecrets(`before ${value} after`);
    assert.equal(redacted.includes(value), false, `${name}: raw value survived: ${redacted}`);
    assert.match(redacted, /\[REDACTED\]/, name);
    assert.equal(hasSecretShape(value), true, `${name}: hasSecretShape`);
    assert.equal(shipScan(`+const k = "${value}"`), name, `${name}: Ship scan`);
    assert.equal(guardScan(`const k = "${value}"`), true, `${name}: guard pre-ingest scan`);
  }
});

const NEAR_MISS = [
  { name: 'short github_pat_', value: 'github_pat_abc123' },
  { name: 'test-mode Stripe key', value: `sk_test_${'a1'.repeat(12)}` },
  { name: 'short npm token', value: 'npm_abc123' },
  { name: 'Slack non-webhook URL', value: 'https://hooks.slack.com/team/T123' },
  { name: 'plain URL', value: 'https://example.com/path?q=1' },
  { name: 'URL with an @ in the path', value: 'https://example.com/@alice' },
  { name: 'scp-style git remote', value: 'git@github.com:acme/web.git' },
];

test('near misses are not redacted and not blocked', () => {
  for (const { name, value } of NEAR_MISS) {
    assert.equal(redactSecrets(`see ${value} now`), `see ${value} now`, `${name}: redaction changed it`);
    assert.equal(hasSecretShape(value), false, `${name}: hasSecretShape`);
    assert.equal(shipScan(`+${value}`), null, `${name}: Ship scan`);
    assert.equal(guardScan(value), false, `${name}: guard scan`);
  }
});

test("redaction-only heuristics do not block Ship on ordinary code", () => {
  for (const line of [
    "+const x = opts.apiKey;",
    "+const token = generateHostApprovalToken(user);",
    "+Authorization: Bearer YOUR_ACCESS_TOKEN_GOES_HERE",
    "+ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePublicKeyMaterialForAFixtureOnly12345",
  ]) assert.equal(shipScan(line), null, line);
});

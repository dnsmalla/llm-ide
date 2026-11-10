// R-036 A6: ONE credential-shape list in core, imported by the redactor, the guardrails and the Factory Ship
// pre-push scan. Positive cases prove all three see a shape; near misses prove the shapes stay specific.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECRET_SHAPES } from '../core/secret-patterns.mjs';
import { redactSecrets, hasSecretShape } from '../core/redact-secrets.mjs';
import { SECRET_PATTERNS } from '../guardrails/rules.mjs';
import { scanForSecrets as guardScan } from '../guardrails/scan.mjs';
import { scanForSecrets as shipScan, scanForSecretsDetailed } from '../agents/github-pr.mjs';

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
  { name: 'URL with credentials', value: `postgres://alice:s3cret@db.acme.internal/app` },
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

test("credential literals still gate, but identifier/call forms do not (R-044 #1)", () => {
  for (const line of [
    "+const password = \"hunter2hunter2hunter2xx\";",
    "+api_key = \"abcd1234abcd1234abcd\"",
    "+client_secret: 9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  ]) assert.equal(shipScan(line), "Credential literal", line);
  for (const line of ["+const token = generateHostApprovalToken(user);", "+apiKey=opts.apiKey"]) assert.equal(shipScan(line), null, line);
});

test("a loopback/example URL is not gated; a real host is (R-044 #2)", () => {
  assert.equal(shipScan("+postgres://test:test@localhost:5432/db"), null);
  assert.equal(shipScan("+postgres://alice:s3cret@db.example.com/app"), null);
  assert.equal(shipScan("+postgres://alice:s3cret@db.acme.internal/app"), "URL with credentials");
});

test("a diff hit reports rule, file and line, never the text (R-044 #3)", () => {
  const fake = `ghp_${'Ab1'.repeat(12)}`;
  const diff = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -0,0 +1,2 @@", "+safe", `+${fake}`].join("\n");
  assert.deepEqual(scanForSecretsDetailed(diff), { rule: "GitHub token", file: "src/a.ts", line: 2 });
});

test("R-046 #1: credential-shaped literals block, ordinary UI/template/env text does not", () => {
  for (const line of [
    "+const password = \"hunter2hunter2hunter2xx\";",
    "+api_key = \"abcd1234abcd1234abcd\"",
    "+client_secret: 9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  ]) assert.equal(shipScan(line), "Credential literal", line);
  for (const line of [
    "+password: \"Enter your password to continue\",",
    "+api_key: \"${{ secrets.OPENAI_API_KEY }}\"",
    "+password: \"process.env.DB_PASSWORD_VALUE\"",
    "+password = \"<your-password-goes-here>\"",
    "+password = get_password_from_keychain_value",
  ]) assert.equal(shipScan(line), null, line);
});

test("R-046 #2: quoted JSON keys and token/secret literals block", () => {
  assert.equal(shipScan('+"password": "Zx9vQ2LmN8rT4wYb6cHd1234"'), "Credential literal");
  assert.equal(shipScan('+"api_key": "abcd1234abcd1234abcd"'), "Credential literal");
  assert.equal(shipScan('+"token": "Zx9vQ2LmN8rT4wYb6cHd1234"'), "Credential literal");
  assert.equal(shipScan('+"secret": "Zx9vQ2LmN8rT4wYb6cHd1234"'), "Credential literal");
});

test("R-046 #3: quoted/bracketed/multiple local URLs are exempt only when every host is local", () => {
  for (const line of [
    '+"postgres://u:pw@localhost"',
    "+postgres://u:pw@'localhost'",
    "+postgres://u:pw@localhost)",
    "+postgres://u:pw@localhost,",
    "+postgres://u:pw@[::1]:5432/db",
    "+a=postgres://u:p@localhost/db b=postgres://u:p@127.0.0.1/x",
    "+postgres://u:p@example.com/db",
  ]) assert.equal(shipScan(line), null, line);
  assert.equal(shipScan("+a=postgres://u:p@localhost/db b=postgres://u:real@prod.db.io/x"), "URL with credentials");
});

test("R-047: a quoted secret with symbols and an unquoted one with a comment still block", () => {
  assert.equal(shipScan('+password: "Zx9vQ2LmN8rT4wYb6cHd!@#"'), "Credential literal");
  assert.equal(shipScan("+PASSWORD: Zx9vQ2LmN8rT4wYb6cHd1234  # prod"), "Credential literal");
  assert.equal(shipScan("+postgres://u:real@localhost_prod.db.io/x"), "URL with credentials");
});

test("R-048 #3: call forms, shell variables and command substitution pass", () => {
  for (const line of [
    "+token = getTokenForUserSession2(request)",
    "+password = hashPasswordV2(user_password_input)",
    "+PASSWORD=$DB_PASSWORD_V2_PRODUCTION",
    '+password: "$(openssl_rand_base64_32)"',
  ]) assert.equal(shipScan(line), null, line);
});

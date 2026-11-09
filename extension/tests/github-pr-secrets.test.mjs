// Coverage for github-pr.mjs scanForSecrets — the pre-push PR-branch secret
// gate. Regression guard for the divergence where this (a third copy of the
// secret-pattern set) missed GitLab non-PAT tokens and OpenAI sk-proj- keys
// that core/redact-secrets.mjs + guardrails/rules.mjs already caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanForSecrets } from '../agents/github-pr.mjs';

// scanForSecrets only inspects ADDED diff lines (leading '+', not '+++').
const added = (s) => `+${s}`;

test('scanForSecrets catches an OpenAI project key (sk-proj-)', () => {
  assert.equal(
    scanForSecrets(added('const k = "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa"')),
    'OpenAI project key',
  );
});

test('scanForSecrets catches non-PAT GitLab tokens (glrt-/gldt-)', () => {
  assert.equal(scanForSecrets(added('GITLAB_RUNNER=glrt-aaaaaaaaaaaaaaaaaaaa')), 'GitLab token');
  assert.equal(scanForSecrets(added('DEPLOY=gldt-aaaaaaaaaaaaaaaaaaaa')), 'GitLab token');
});

test('scanForSecrets still catches the previously-covered shapes', () => {
  assert.equal(scanForSecrets(added('token glpat-aaaaaaaaaaaaaaaaaaaa')), 'GitLab token');
  assert.equal(scanForSecrets(added('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')), 'GitHub token');
  assert.equal(scanForSecrets(added('AKIAIOSFODNN7EXAMPLE')), 'AWS access key id');
  assert.equal(scanForSecrets(added('sk-ant-aaaaaaaaaaaaaaaaaaaa')), 'Anthropic API key');
});

test('scanForSecrets ignores diff metadata and clean lines', () => {
  assert.equal(scanForSecrets('+++ b/src/config.ts'), null);
  assert.equal(scanForSecrets(added('const timeout = 30000 // ms')), null);
  assert.equal(scanForSecrets('-const k = "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa"'), null, 'removed lines are not scanned');
});

test('C1c-3: an added line whose content begins with ++ is scanned; file headers are not', () => {
  const fake = `ghp_${'Ab1'.repeat(12)}`;
  const diff = [
    'diff --git a/x.txt b/x.txt', 'index 1..2 100644', '--- a/x.txt', '+++ b/x.txt', '@@ -1 +1,2 @@',
    '-old', `+++ ${fake}`, '',
  ].join('\n');
  assert.equal(scanForSecrets(diff), 'GitHub token');
  assert.equal(scanForSecrets(`+++${fake}`), 'GitHub token', 'headerless text: every + line is content');
  const headerOnly = ['diff --git a/ghp_x b/ghp_x', '--- a/x', `+++ b/${fake}`, '@@ -0,0 +1 @@', '+safe'].join('\n');
  assert.equal(scanForSecrets(headerOnly), null, 'a file NAME in the +++ header is metadata');
});

// Tests for the guardrail rule engine.  These rules sit between every
// LLM-generated artifact and any real-world side-effect, so coverage
// here is the highest-leverage place to catch regressions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuardrails } from '../guardrails/rules.mjs';

const ok = (kind, payload) => runGuardrails(kind, payload);
const blocking = (kind, payload, ruleId) => {
  const r = ok(kind, payload);
  assert.equal(r.passed, false, `expected blocking finding for ${ruleId}`);
  assert.ok(
    r.blocking.some((f) => f.ruleId === ruleId),
    `expected blocking ruleId=${ruleId}, got: ${r.blocking.map((f) => f.ruleId).join(', ')}`,
  );
};

test('dispatch — empty target is blocked', () => {
  blocking('dispatch', { items: [{ title: 't', body: 'b' }] }, 'dispatch.target');
});

test('dispatch — missing GitHub creds blocks', () => {
  blocking('dispatch', {
    target: 'github',
    items: [{ title: 't', body: 'b' }],
    config: {},
  }, 'dispatch.creds');
});

test('dispatch — missing Linear creds blocks', () => {
  blocking('dispatch', {
    target: 'linear',
    items: [{ title: 't', body: 'b' }],
    config: { teamId: 'x' },          // missing apiKey
  }, 'dispatch.creds');
});

test('dispatch — GitHub PAT in body blocks via secret rule', () => {
  blocking('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'ok', body: 'paste ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here' }],
  }, 'dispatch.secret');
});

test('dispatch — AWS access key in body blocks', () => {
  blocking('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'ok', body: 'AKIAIOSFODNN7EXAMPLE is the key' }],
  }, 'dispatch.secret');
});

test('dispatch — clean payload passes', () => {
  const r = ok('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'Add MFA', body: 'Implement MFA per the compliance memo.' }],
  });
  assert.equal(r.passed, true);
  assert.equal(r.blocking.length, 0);
});

test('codegen-apply — path with .. is blocked', () => {
  blocking('codegen-apply', {
    repoPath: '/tmp/repo',
    allowedRepos: ['/tmp/repo'],
    files: [{ path: '../../etc/passwd', content: 'x' }],
    tests: [],
  }, 'codegen.path-escape');
});

test('codegen-apply — absolute path is blocked', () => {
  blocking('codegen-apply', {
    repoPath: '/tmp/repo',
    allowedRepos: ['/tmp/repo'],
    files: [{ path: '/etc/passwd', content: 'x' }],
    tests: [],
  }, 'codegen.path-escape');
});

test('codegen-apply — path outside allowlist is blocked', () => {
  blocking('codegen-apply', {
    repoPath: '/etc',
    allowedRepos: ['/tmp/repo'],
    files: [{ path: 'hosts', content: 'x' }],
    tests: [],
  }, 'codegen.allowlist');
});

test('codegen-apply — empty allowlist is blocked', () => {
  blocking('codegen-apply', {
    repoPath: '/tmp/repo',
    allowedRepos: [],
    files: [{ path: 'a.ts', content: 'x' }],
    tests: [],
  }, 'codegen.allowlist');
});

test('codegen-apply — secret in file content is blocked', () => {
  blocking('codegen-apply', {
    repoPath: '/tmp/repo',
    allowedRepos: ['/tmp/repo'],
    files: [{ path: 'a.ts', content: 'const KEY = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";' }],
    tests: [],
  }, 'codegen.secret');
});

test('codegen-apply — destructive shell op is a warning, not blocking', () => {
  const r = ok('codegen-apply', {
    repoPath: '/tmp/repo',
    allowedRepos: ['/tmp/repo'],
    files: [{ path: 'cleanup.sh', content: '#!/bin/sh\nrm -rf /tmp/foo' }],
    tests: [],
  });
  assert.equal(r.passed, true, 'destructive ops do not block');
  assert.ok(r.warnings.some((w) => w.ruleId === 'codegen.destructive'));
});

test('codegen-apply — clean change passes', () => {
  const r = ok('codegen-apply', {
    repoPath: '/tmp/repo',
    allowedRepos: ['/tmp/repo'],
    files: [{ path: 'src/auth.ts', content: 'export function login() { return true; }\n' }],
    tests: [{ path: 'src/auth.test.ts', content: 'import { login } from "./auth";\n' }],
  });
  assert.equal(r.passed, true);
});

test('unknown kind is blocked', () => {
  blocking('unknown-kind', {}, 'guardrail.kind');
});

test('info findings always include a summary line', () => {
  const r = ok('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 't', body: 'b' }],
  });
  assert.ok(r.info.some((i) => i.ruleId === 'dispatch.summary'));
});

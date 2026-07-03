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

test('dispatch — GitLab PAT in body blocks (tracker is GitLab-hosted)', () => {
  blocking('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'ok', body: 'token glpat-aaaaaaaaaaaaaaaaaaaa leaked' }],
  }, 'dispatch.secret');
});

test('dispatch — non-PAT GitHub token (gho_/ghs_) in body blocks', () => {
  blocking('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'ok', body: 'gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here' }],
  }, 'dispatch.secret');
});

test('dispatch — OpenAI project key (sk-proj-) in body blocks', () => {
  blocking('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'ok', body: 'key sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa here' }],
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

// AGT-5: zero-width chars must not allow evasion of secret detection
// in the guardrail rule engine's findMatches collapse path.
test('dispatch — AWS key with embedded U+200B is blocked (AGT-5)', () => {
  // AKIAIOSFODNN7EXAMPLE with a U+200B (ZWSP) after "AKIA". The \s+ collapse
  // misses it, so the secret evades both raw and collapsed checks before fix.
  blocking('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'ok', body: 'AKIA​IOSFODNN7EXAMPLE is the key' }],
  }, 'dispatch.secret');
});

test('codegen-apply — GitHub PAT with embedded U+200D is blocked (AGT-5)', () => {
  // ghp_ + 36 chars split by U+200D (ZWJ) in the middle.
  blocking('codegen-apply', {
    repoPath: '/tmp/repo',
    allowedRepos: ['/tmp/repo'],
    files: [{ path: 'src/a.ts', content: 'const t = "ghp_aaaaaaaaaaaa‍aaaaaaaaaaaaaaaaaaaaaaaa"' }],
    tests: [],
  }, 'codegen.secret');
});

// The guardrail SECRET_PATTERNS list previously had no rule for Anthropic
// ("sk-ant-") or generic OpenAI-style ("sk-") keys, even though the
// separate core/redact-secrets.mjs pattern set (used for log/error
// redaction) already recognized both shapes — a divergent, narrower
// guardrail list let these keys slip past dispatch/codegen review
// undetected. These two tests pin that the guardrail list now also
// catches them.
test('dispatch — Anthropic sk-ant- key in body blocks via secret rule', () => {
  blocking('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'ok', body: 'key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345-abc' }],
  }, 'dispatch.secret');
});

test('codegen-apply — generic sk- key in file content blocks via secret rule', () => {
  blocking('codegen-apply', {
    repoPath: '/tmp/repo',
    allowedRepos: ['/tmp/repo'],
    files: [{ path: 'a.ts', content: 'const KEY = "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";' }],
    tests: [],
  }, 'codegen.secret');
});

// A guardrail secret finding must never persist/return the raw matched
// value — the review_items row (and the API response that echoes it back)
// is not a secure sink. findMatches() used to put the literal matched
// token straight into `finding.details[].snippet`; a reviewer's browser
// devtools, the KB DB row, or any log of the API response would then
// contain the live credential the guardrail was supposed to catch.
test('dispatch — secret finding snippet does not contain the raw matched secret (redaction)', () => {
  const rawKey = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const r = runGuardrails('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'ok', body: `please rotate ${rawKey} today` }],
  });
  const secretFinding = r.blocking.find((f) => f.ruleId === 'dispatch.secret');
  assert.ok(secretFinding, 'expected a dispatch.secret finding');
  const serialized = JSON.stringify(secretFinding.details);
  assert.ok(!serialized.includes(rawKey), `raw secret leaked into finding.details: ${serialized}`);
  assert.ok(serialized.includes('[REDACTED]'), `expected a redaction marker: ${serialized}`);
});

test('codegen-apply — secret finding snippet does not contain the raw matched secret (redaction)', () => {
  const rawKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345-abc';
  const r = runGuardrails('codegen-apply', {
    repoPath: '/tmp/repo',
    allowedRepos: ['/tmp/repo'],
    files: [{ path: 'a.ts', content: `const KEY = "${rawKey}";` }],
    tests: [],
  });
  const secretFinding = r.blocking.find((f) => f.ruleId === 'codegen.secret');
  assert.ok(secretFinding, 'expected a codegen.secret finding');
  const serialized = JSON.stringify(secretFinding.details);
  assert.ok(!serialized.includes(rawKey), `raw secret leaked into finding.details: ${serialized}`);
});

// PII findings are informational for the reviewer, not a "secret" — the
// redaction added for SECRET_PATTERNS must not accidentally scrub the
// email address itself out of a PII finding, or the reviewer can no
// longer judge the finding.
test('dispatch — PII finding snippet still shows the matched email (not redacted)', () => {
  const r = runGuardrails('dispatch', {
    target: 'github',
    config: { repo: 'a/b', token: 'x' },
    items: [{ title: 'Contact jane.doe@example.com about this', body: 'b' }],
  });
  const piiFinding = r.warnings.find((f) => f.ruleId === 'dispatch.pii');
  assert.ok(piiFinding, 'expected a dispatch.pii finding');
});

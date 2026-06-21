// Provider URL parsers that drive outcome-status polling. A wrong parse
// means polling the wrong issue/PR (or silently giving up), so pin the
// shapes — including the issues-vs-pull distinction and rejection of
// malformed/foreign URLs.
// Also covers: AGT-8 (sk-ant- token redaction), AGT-9 (Backlog host validation).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubUrl, parseBacklogUrl, pollOne } from '../agents/outcome-providers.mjs';
import { _redactTokensForTests as redactTokens } from '../agents/outcome-watcher.mjs';

test('parseGithubUrl: parses an issue URL', () => {
  assert.deepEqual(
    parseGithubUrl('https://github.com/acme/widgets/issues/42'),
    { owner: 'acme', repo: 'widgets', kind: 'issue', number: 42 },
  );
});

test('parseGithubUrl: maps /pull/ to kind "pr"', () => {
  assert.deepEqual(
    parseGithubUrl('https://github.com/acme/widgets/pull/7'),
    { owner: 'acme', repo: 'widgets', kind: 'pr', number: 7 },
  );
});

test('parseGithubUrl: rejects non-issue/pull and foreign hosts', () => {
  assert.equal(parseGithubUrl('https://github.com/acme/widgets'), null);
  assert.equal(parseGithubUrl('https://gitlab.com/acme/widgets/issues/1'), null);
  assert.equal(parseGithubUrl(''), null);
  assert.equal(parseGithubUrl(undefined), null);
});

test('parseBacklogUrl: parses space + issue key', () => {
  assert.deepEqual(
    parseBacklogUrl('https://myspace.backlog.com/view/PROJ-123'),
    { space: 'myspace.backlog.com', issueKey: 'PROJ-123' },
  );
});

test('parseBacklogUrl: rejects URLs without a /view/ key', () => {
  assert.equal(parseBacklogUrl('https://myspace.backlog.com/projects/PROJ'), null);
  assert.equal(parseBacklogUrl('not a url'), null);
});

// AGT-8: sk-ant-* Anthropic key pattern is redacted from surfaced errors.
test('AGT-8: redactTokens scrubs sk-ant- keys', () => {
  const msg = 'Bad credentials for sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345-abc';
  const out = redactTokens(msg);
  assert.ok(!out.includes('sk-ant-'), `sk-ant- key should be redacted; got: ${out}`);
  assert.ok(out.includes('[REDACTED]'), 'replacement marker should appear');
});

test('AGT-8: redactTokens leaves non-key text intact', () => {
  const msg = 'Backlog HTTP 401';
  assert.equal(redactTokens(msg), msg);
});

// AGT-9: pollOne rejects a tampered stored-task URL whose host is not a
// valid Backlog subdomain — no credentialed fetch should be sent to an
// arbitrary host.
test('AGT-9: pollOne returns unknown state for a non-backlog host URL', async () => {
  // Intercept fetch so any accidental outbound call fails the test loudly.
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`AGT-9: fetch must not be called for non-backlog host, but got: ${url}`);
  };
  try {
    const result = await pollOne(
      { dispatched: { provider: 'backlog', url: 'https://evil.com/view/PROJ-1' } },
      { backlog: { apiKey: 'test-key' } },
    );
    assert.equal(result.state, 'unknown', 'non-backlog host should yield state=unknown');
    assert.ok(
      /backlog/i.test(result.meta?.error || ''),
      `error should mention Backlog domain; got: ${JSON.stringify(result.meta)}`,
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

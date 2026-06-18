// Provider URL parsers that drive outcome-status polling. A wrong parse
// means polling the wrong issue/PR (or silently giving up), so pin the
// shapes — including the issues-vs-pull distinction and rejection of
// malformed/foreign URLs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubUrl, parseBacklogUrl } from '../agents/outcome-providers.mjs';

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

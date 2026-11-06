import { test } from 'node:test';
import assert from 'node:assert/strict';
// Load the pinned fetch before any test swaps globalThis.fetch: its NODE_ENV=test seam honours a swap
// only when the module saw the original fetch first.
import '../server/pinned-fetch.mjs';
process.env.NODE_ENV = 'test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPullRequest, assertSafeGhRepo, assertSafeBaseBranch, createDraftPr } from '../agents/github-pr.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghpr-'));
const files = [{ path: 'a.txt', content: 'x' }];

test('ghRepo validation', () => {
  assertSafeGhRepo('octo/repo.js');
  for (const bad of ['octo', 'a/b/c', '../x', 'a/..', 'a b/c', 'a/b?x=1', 'a/b#', '', null]) {
    assert.throws(() => assertSafeGhRepo(bad), /Invalid GitHub repo/, String(bad));
  }
});

test('baseBranch validation', async () => {
  for (const ok of ['main', 'release/1.2', 'feat_x-y']) await assertSafeBaseBranch(dir, ok);
  for (const bad of ['--orphan', '-b', 'a..b', 'a b', 'x.lock', 'a/', '@{-1}', 'a\nb', '']) {
    await assert.rejects(() => assertSafeBaseBranch(dir, bad), /Invalid base branch/, JSON.stringify(bad));
  }
});

test('openPullRequest rejects bad inputs before any git command or network call', async () => {
  const origFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return new Response('{}'); };
  try {
    // dir is not a git repo: reaching git would yield a git error, not ours.
    await assert.rejects(
      () => openPullRequest({ repoPath: dir, taskId: 't', files, ghRepo: '../evil', ghToken: 'x' }),
      /Invalid GitHub repo/);
    await assert.rejects(
      () => openPullRequest({ repoPath: dir, taskId: 't', files, ghRepo: 'o/r', ghToken: 'x', baseBranch: '--orphan' }),
      /Invalid base branch/);
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = origFetch; }
});

test('createDraftPr posts a draft to api.github.com only and refuses a redirect', async () => {
  const origFetch = globalThis.fetch; const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return seen.length === 1 ? new Response(JSON.stringify({ html_url: 'https://github.com/o/r/pull/1', number: 1, state: 'open', draft: true }), { status: 201 }) : new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }); };
  const args = { ghRepo: 'o/r', ghToken: 'ghp_test', title: 't', head: 'h', base: 'main', body: 'b' };
  try {
    const pr = await createDraftPr(args); assert.equal(pr.number, 1);
    assert.equal(seen[0].url, 'https://api.github.com/repos/o/r/pulls'); assert.equal(seen[0].init.redirect, 'manual'); assert.equal(JSON.parse(seen[0].init.body).draft, true);
    await assert.rejects(() => createDraftPr(args), /redirect 301 not followed/);
    await assert.rejects(() => createDraftPr({ ...args, ghRepo: '../evil' }), /Invalid GitHub repo/);
    assert.equal(seen.length, 2);
  } finally { globalThis.fetch = origFetch; }
});

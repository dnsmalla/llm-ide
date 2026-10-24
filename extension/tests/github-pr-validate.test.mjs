import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPullRequest, assertSafeGhRepo, assertSafeBaseBranch } from '../agents/github-pr.mjs';

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

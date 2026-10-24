import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyCodegen } from '../agents/codegen-apply.mjs';

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cga-')));
  const repo = path.join(root, 'repo');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(repo);
  fs.mkdirSync(outside);
  return { repo, outside };
}

test('symlinked component in target path: no directories created outside', () => {
  const { repo, outside } = setup();
  fs.mkdirSync(path.join(repo, '.llmide-auto', 't1'), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, '.llmide-auto', 't1', 'foo'));
  assert.throws(() => applyCodegen({
    repoPath: repo, taskId: 't1', allowedRepos: [repo],
    files: [{ path: 'foo/newdir/x.txt', content: 'x' }],
  }), /symlink/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('symlinked task dir: refused before mkdir', () => {
  const { repo, outside } = setup();
  fs.mkdirSync(path.join(repo, '.llmide-auto'));
  fs.symlinkSync(outside, path.join(repo, '.llmide-auto', 't1'));
  assert.throws(() => applyCodegen({
    repoPath: repo, taskId: 't1', allowedRepos: [repo],
    files: [{ path: 'a/b.txt', content: 'x' }],
  }), /symlink/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('normal write still works', () => {
  const { repo } = setup();
  const r = applyCodegen({ repoPath: repo, taskId: 't1', allowedRepos: [repo], files: [{ path: 'a/b.txt', content: 'hi' }] });
  assert.equal(r.count, 1);
  assert.equal(fs.readFileSync(path.join(repo, '.llmide-auto/t1/a/b.txt'), 'utf8'), 'hi');
});

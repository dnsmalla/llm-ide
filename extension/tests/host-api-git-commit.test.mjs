import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitCommit } from '../routes/host-api/git-commit.mjs';

function repo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-commit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'one\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'base']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'two\n');
  return root;
}

test('commits only the selected path', async (t) => {
  const root = repo(t);
  const out = await gitCommit(root, { message: 'change a', paths: ['a.txt'] });
  assert.match(out.commit, /^[0-9a-f]{7,}$/);
  assert.equal(execFileSync('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim(), 'a.txt');
  assert.match(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), /b\.txt/);
});

test('refuses empty messages and paths outside the repo', async (t) => {
  const root = repo(t);
  await assert.rejects(() => gitCommit(root, { message: '  ', paths: ['a.txt'] }), /message/);
  await assert.rejects(() => gitCommit(root, { message: 'x', paths: ['../outside'] }), /path/);
  await assert.rejects(() => gitCommit(root, { message: 'x', paths: ['/etc/passwd'] }), /path/);
});

test('reports nothing to commit', async (t) => {
  const root = repo(t);
  await gitCommit(root, { message: 'a', paths: ['a.txt'] });
  await assert.rejects(() => gitCommit(root, { message: 'again', paths: ['a.txt'] }), /nothing to commit/);
});

test('refuses pathspec magic, dot, globs and denied paths', async (t) => {
  const root = repo(t);
  for (const bad of ['.', ':(top)a.txt', ':/', ':!a.txt', '*', 'sub/*.txt', '.env', 'k/id.pem', 'sub/./a.txt']) {
    await assert.rejects(() => gitCommit(root, { message: 'x', paths: [bad] }), /path/, bad);
  }
});

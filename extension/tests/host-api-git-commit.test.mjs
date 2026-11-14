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

test('commits only the selected path', (t) => {
  const root = repo(t);
  const out = gitCommit(root, { message: 'change a', paths: ['a.txt'] });
  assert.match(out.commit, /^[0-9a-f]{7,}$/);
  assert.equal(execFileSync('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim(), 'a.txt');
  assert.match(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), /b\.txt/);
});

test('refuses empty messages and paths outside the repo', (t) => {
  const root = repo(t);
  assert.throws(() => gitCommit(root, { message: '  ', paths: ['a.txt'] }), /message/);
  assert.throws(() => gitCommit(root, { message: 'x', paths: ['../outside'] }), /path/);
  assert.throws(() => gitCommit(root, { message: 'x', paths: ['/etc/passwd'] }), /path/);
});

test('reports nothing to commit', (t) => {
  const root = repo(t);
  gitCommit(root, { message: 'a', paths: ['a.txt'] });
  assert.throws(() => gitCommit(root, { message: 'again', paths: ['a.txt'] }), /nothing to commit/);
});

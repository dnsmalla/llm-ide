import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkArgv, terminalExec } from '../routes/host-api/terminal-exec.mjs';

function repo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-term-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'one']);
  return root;
}

test('runs pwd and git status without a shell', (t) => {
  const root = repo(t);
  assert.equal(terminalExec(root, { argv: ['pwd'] }).stdout.trim(), root);
  assert.equal(terminalExec(root, { argv: ['git', 'status', '--porcelain'] }).stdout, '');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  assert.match(terminalExec(root, { argv: ['git', 'diff'] }).stdout, /\+two/);
});

test('refuses shells, git config injection and outside paths', () => {
  assert.throws(() => checkArgv(['sh', '-c', 'id']), /allowlist|not allowed/);
  assert.throws(() => checkArgv(['git', '-c', 'core.pager=id', 'log']), /not allowed/);
  assert.throws(() => checkArgv(['ls', '../']), /not allowed/);
  assert.throws(() => checkArgv(['cat', 'a.txt']), /allowlist/);
  assert.throws(() => checkArgv(['git', 'diff', '--output=/tmp/x']), /not allowed/);
});

test('refuses a path into .git and accepts npm test only', () => {
  assert.throws(() => checkArgv(['rg', '.git/config']), /not readable/);
  assert.doesNotThrow(() => checkArgv(['npm', 'test']));
  assert.throws(() => checkArgv(['npm', 'install']), /npm test/);
});

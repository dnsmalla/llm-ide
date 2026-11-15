import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitStatus, gitDiff } from '../routes/host-api/git-read.mjs';

function repo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-git-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'one']);
  return root;
}

test('clean status, then a modified file and its diff', async (t) => {
  const root = repo(t);
  assert.equal((await gitStatus(root)).clean, true);
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  const s = await gitStatus(root);
  assert.equal(s.clean, false);
  assert.equal(s.entries.find((e) => e.path === 'a.txt').status, 'M');
  assert.match((await gitDiff(root, { path: 'a.txt' })).patch, /\+two/);
});

test('a path outside the repository is refused before git runs', async (t) => {
  const root = repo(t);
  await assert.rejects(() => gitDiff(root, { path: '../outside' }), /not valid/);
  await assert.rejects(() => gitDiff(root, { path: '/etc/passwd' }), /not valid/);
});

test('a diff over the cap is truncated', async (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, 'a.txt'), `${'x'.repeat(300_000)}\n`);
  const out = await gitDiff(root, { path: 'a.txt' });
  assert.equal(out.truncated, true);
  assert.equal(Buffer.byteLength(out.patch, 'utf8'), 262_144);
});

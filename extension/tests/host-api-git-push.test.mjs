import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitPush } from '../routes/host-api/git-push.mjs';

test('pushes a new commit to the configured upstream', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-push-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bare = path.join(base, 'remote.git');
  const local = path.join(base, 'local');
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['init', '-q', local]);
  execFileSync('git', ['-C', local, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', local, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(local, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', local, 'add', '.']);
  execFileSync('git', ['-C', local, 'commit', '-q', '-m', 'one']);
  execFileSync('git', ['-C', local, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', local, 'push', '-q', '-u', 'origin', 'HEAD']);
  fs.writeFileSync(path.join(local, 'a.txt'), 'two\n');
  execFileSync('git', ['-C', local, 'commit', '-q', '-am', 'two']);
  const out = gitPush(local);
  assert.equal(out.ok, true);
  assert.match(execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /two/);
});

test('a repository without a remote fails with a clear error', (t) => {
  const local = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-push2-')));
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', local]);
  execFileSync('git', ['-C', local, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', local, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(local, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', local, 'add', '.']);
  execFileSync('git', ['-C', local, 'commit', '-q', '-m', 'one']);
  assert.throws(() => gitPush(local), /remote|upstream|push/i);
});

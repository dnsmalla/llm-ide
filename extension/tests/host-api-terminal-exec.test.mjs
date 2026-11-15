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

test('runs pwd and git status without a shell', async (t) => {
  const root = repo(t);
  assert.equal((await terminalExec(root, { argv: ['pwd'] })).stdout.trim(), root);
  assert.equal((await terminalExec(root, { argv: ['git', 'status', '--porcelain'] })).stdout, '');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  assert.match((await terminalExec(root, { argv: ['git', 'diff'] })).stdout, /\+two/);
});

test('refuses shells, git config injection and outside paths', async () => {
  assert.throws(() => checkArgv(['sh', '-c', 'id']), /allowlist|not allowed/);
  assert.throws(() => checkArgv(['git', '-c', 'core.pager=id', 'log']), /not allowed/);
  assert.throws(() => checkArgv(['ls', '../']), /not allowed/);
  assert.throws(() => checkArgv(['cat', 'a.txt']), /allowlist/);
  assert.throws(() => checkArgv(['git', 'diff', '--output=/tmp/x']), /not allowed/);
});

test('refuses a path into .git and accepts npm test only', async () => {
  assert.throws(() => checkArgv(['rg', '.git/config']), /not readable/);
  assert.doesNotThrow(() => checkArgv(['npm', 'test']));
  assert.throws(() => checkArgv(['npm', 'install']), /npm test/);
});

test('refuses flags that run programs or reach secret files (rg, go, npm, cargo)', () => {
  const refused = [
    ['rg', '--pre=sh', 'x'], ['rg', '--pre', 'sh', 'x'], ['rg', '--pre-glob=*', 'x'], ['rg', '-u', 'x'], ['rg', '-uu', 'x'], ['rg', '-uuu', 'x'],
    ['rg', '--unrestricted', 'x'], ['rg', '--hidden', 'x'], ['rg', '--no-ignore', 'x'], ['rg', '--no-ignore-vcs', 'x'],
    ['rg', '-L', 'x'], ['rg', '--follow', 'x'], ['rg', '-z', 'x'], ['rg', '--search-zip', 'x'], ['rg', '--config-path=x', 'x'],
    ['go', 'test', '-exec=sh'], ['go', 'test', '-exec', 'sh'], ['go', 'test', '-toolexec=sh'], ['go', 'test', '-o=x'],
    ['npm', 'test', '--script-shell=python3'], ['npm', 'test', '--', 'x'], ['npm', 'run', 'test', '--script-shell=sh'],
    ['cargo', 'test', '--config', 'x'], ['cargo', 'test', '--config=x'], ['cargo', 'test', '-Z', 'x'],
    ['swift', 'test', '--build-path=x'], ['ls', '--color=always'],
  ];
  for (const argv of refused) assert.throws(() => checkArgv(argv), /allowed|not readable|unsupported/, argv.join(' '));
  for (const argv of [['rg', '-n', 'foo', 'src'], ['rg', '-A', '3', 'foo'], ['go', 'test', '-run=TestX', './...'], ['cargo', 'test', '--release'], ['ls', '-la']]) {
    assert.doesNotThrow(() => checkArgv(argv), argv.join(' '));
  }
});

test('path-like git and rg operands use the files.read denylist, including rev:path', () => {
  assert.throws(() => checkArgv(['git', 'show', 'HEAD:.env']), /not readable/);
  assert.throws(() => checkArgv(['git', 'show', 'HEAD:config/server.pem']), /not readable/);
  assert.throws(() => checkArgv(['git', 'log', '--', '.env.local']), /not readable/);
  assert.throws(() => checkArgv(['rg', 'token', '.env']), /not readable/);
  assert.throws(() => checkArgv(['rg', 'token', 'deploy/id_rsa']), /not readable/);
  assert.doesNotThrow(() => checkArgv(['git', 'show', 'HEAD:src/app.js']));
});

test('git branch only lists', () => {
  for (const flag of ['-D', '-d', '-m', '-M', '-u', '-f', '--set-upstream-to=x', '-c']) {
    assert.throws(() => checkArgv(['git', 'branch', flag, 'x']), /not allowed|only lists/, flag);
  }
  assert.throws(() => checkArgv(['git', 'branch', 'newbranch']), /only lists/);
  for (const argv of [['git', 'branch'], ['git', 'branch', '-a'], ['git', 'branch', '-vv'], ['git', 'branch', '--list']]) assert.doesNotThrow(() => checkArgv(argv));
});

test('rg never returns secret files even when the path is not named', async (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=hunter2\n');
  fs.writeFileSync(path.join(root, 'prod.pem'), 'SECRET_TOKEN=pem\n');
  fs.writeFileSync(path.join(root, 'ok.txt'), 'SECRET_TOKEN=public\n');
  const out = await terminalExec(root, { argv: ['rg', 'SECRET_TOKEN'] });
  if (out.exitCode === null) return; // rg is not installed on this machine
  assert.match(out.stdout, /ok\.txt/);
  assert.doesNotMatch(out.stdout, /hunter2|pem/);
});

test('a child never sees the core secrets, and a timeout kills the whole process group', async (t) => {
  const root = repo(t);
  const keys = ['LLMIDE_JWT_SECRET', 'LLMIDE_VAULT_KEY', 'LLMIDE_HOST_APPROVAL_KEY'];
  for (const key of keys) { process.env[key] = `leak-${key}`; t.after(() => { delete process.env[key]; }); }
  const { shellExec } = await import('../routes/host-api/shell-exec.mjs');
  const { gitCommit } = await import('../routes/host-api/git-commit.mjs');
  const sh = await shellExec(root, { command: 'env' });
  for (const key of keys) assert.doesNotMatch(sh.stdout, new RegExp(key));
  // git hooks run as git children: the commit hook must not see them either.
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nenv > "${path.join(root, 'hook-env.out')}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  await gitCommit(root, { message: 'x', paths: ['a.txt'] });
  const seen = fs.readFileSync(path.join(root, 'hook-env.out'), 'utf8');
  for (const key of keys) assert.doesNotMatch(seen, new RegExp(key));
  // A backgrounded grandchild must die with the timeout, not outlive it.
  const slow = await shellExec(root, { command: 'sleep 30 & echo $!; wait', timeoutMs: 1000 });
  assert.equal(slow.timedOut, true);
  const grandchild = Number(slow.stdout.trim());
  assert.ok(grandchild > 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/);
});

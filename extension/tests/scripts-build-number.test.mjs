// mac/Scripts/build-number.sh: one monotonic CFBundleVersion source (commit count) for local and CI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../mac/Scripts/build-number.sh');
let dir, shallowDir;
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe' });
const run = (repo, env = {}) => {
  const e = { ...process.env, LLMIDE_BUILD_NUMBER_REPO: repo };
  delete e.LLMIDE_BUILD_NUMBER;
  const r = spawnSync('bash', [SCRIPT], { env: { ...e, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-'));
  git(dir, 'init', '-q');
  for (let i = 0; i < 5; i++) git(dir, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
  shallowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-shallow-'));
  fs.rmSync(shallowDir, { recursive: true });
  git(os.tmpdir(), 'clone', '-q', '--depth', '1', `file://${dir}`, shallowDir);
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(shallowDir, { recursive: true, force: true }); });

test('default is the commit count and grows with every commit', () => {
  assert.deepEqual(run(dir), { code: 0, out: '5', err: '' });
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'c5');
  assert.equal(run(dir).out, '6');
});

test('an override at or above the commit count is honoured', () => {
  assert.equal(run(dir, { LLMIDE_BUILD_NUMBER: '6' }).out, '6');
  assert.equal(run(dir, { LLMIDE_BUILD_NUMBER: '900' }).out, '900');
});

test('an override below the commit count fails (CI run_number style values)', () => {
  const r = run(dir, { LLMIDE_BUILD_NUMBER: '3' });
  assert.equal(r.code, 1);
  assert.match(r.err, /below the commit count/);
  assert.equal(r.out, '');
});

test('a non-integer or zero-led override fails', () => {
  for (const v of ['abc', '0', '007', '1.5', '-3', '12 ']) {
    const r = run(dir, { LLMIDE_BUILD_NUMBER: v });
    assert.equal(r.code, 1, `override '${v}'`);
  }
});

test('a shallow clone without an override fails; with one it is accepted with a warning', () => {
  const bad = run(shallowDir);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /shallow/);
  const ok = run(shallowDir, { LLMIDE_BUILD_NUMBER: '77' });
  assert.equal(ok.code, 0);
  assert.equal(ok.out, '77');
  assert.match(ok.err, /unverified/);
});

test('not a git repo without an override fails', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-plain-'));
  try { assert.equal(run(plain).code, 1); } finally { fs.rmSync(plain, { recursive: true }); }
});

test('the real repo yields a positive integer', () => {
  const r = spawnSync('bash', [SCRIPT], { env: { ...process.env, LLMIDE_BUILD_NUMBER: '' }, encoding: 'utf8' });
  if (r.status === 0) assert.match(r.stdout.trim(), /^[1-9][0-9]*$/);
});

test('build.sh and the release workflow use it (no second source)', () => {
  const root = path.resolve(path.dirname(SCRIPT), '../..');
  assert.match(fs.readFileSync(path.join(root, 'mac/Scripts/build.sh'), 'utf8'), /build-number\.sh/);
  const wf = fs.readFileSync(path.join(root, '.github/workflows/mac-release.yml'), 'utf8');
  assert.match(wf, /build-number\.sh/);
  assert.doesNotMatch(wf, /LLMIDE_BUILD_NUMBER:\s*\$\{\{\s*github\.run_number/);
});

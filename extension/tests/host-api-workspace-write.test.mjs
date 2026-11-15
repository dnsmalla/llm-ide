import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProjectFile, hashText, MAX_TEXT } from '../routes/host-api/workspace-write.mjs';

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-write-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  return root;
}

function refuses(fn, code, pattern) {
  assert.throws(fn, (e) => e.code === code && pattern.test(e.message));
}

test('creates a new file and returns its hash', (t) => {
  const root = project(t);
  const out = writeProjectFile({ root, path: 'src/a.txt', text: 'one\n', create: true });
  assert.equal(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8'), 'one\n');
  assert.equal(out.hash, hashText('one\n'));
});

test('refuses a stale hash', (t) => {
  const root = project(t);
  const first = writeProjectFile({ root, path: 'a.txt', text: 'one', create: true });
  assert.throws(() => writeProjectFile({ root, path: 'a.txt', text: 'two', expectedHash: '0'.repeat(64) }), /changed/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one');
  assert.equal(first.size, 3);
});

test('writes when expectedHash matches', (t) => {
  const root = project(t);
  const first = writeProjectFile({ root, path: 'a.txt', text: 'one', create: true });
  const out = writeProjectFile({ root, path: 'a.txt', text: 'two', expectedHash: first.hash });
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two');
  assert.equal(out.hash, hashText('two'));
  assert.equal(out.size, 3);
});

test('mustNotExist refuses an existing file', (t) => {
  const root = project(t);
  writeProjectFile({ root, path: 'a.txt', text: 'one', create: true });
  assert.throws(() => writeProjectFile({ root, path: 'a.txt', text: 'two', mustNotExist: true }), /exists/);
});

test('mustNotExist cannot be combined with expectedHash', (t) => {
  const root = project(t);
  assert.throws(() => writeProjectFile({ root, path: 'a.txt', text: 'x', expectedHash: 'a'.repeat(64), mustNotExist: true }), /expectedHash|mustNotExist/);
});

test('refuses denied paths such as .git', (t) => {
  const root = project(t);
  assert.throws(() => writeProjectFile({ root, path: '.git/config', text: 'x', create: true }), /denied|not writable/);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});

test('refuses an in-project symlink that resolves into .git', (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.symlinkSync(path.join(root, '.git'), path.join(root, 'alias'));
  refuses(() => writeProjectFile({ root, path: 'alias/config', text: 'x', create: true }), 'denied', /not writable/);
  assert.equal(fs.existsSync(path.join(root, '.git', 'config')), false);
  refuses(() => writeProjectFile({ root, path: 'alias/nested/x.txt', text: 'x', create: true }), 'denied', /not writable/);
  assert.equal(fs.existsSync(path.join(root, '.git', 'nested')), false);
});

test('create: false refuses a missing parent folder with not_found', (t) => {
  const root = project(t);
  refuses(() => writeProjectFile({ root, path: 'new/a.txt', text: 'x' }), 'not_found', /folder does not exist/);
  assert.equal(fs.existsSync(path.join(root, 'new')), false);
});

test('refuses NUL text and text over MAX_TEXT bytes as invalid', (t) => {
  const root = project(t);
  refuses(() => writeProjectFile({ root, path: 'a.txt', text: 'a\0b', create: true }), 'invalid', /too large|not text/);
  refuses(() => writeProjectFile({ root, path: 'b.txt', text: 'a'.repeat(MAX_TEXT + 1), create: true }), 'invalid', /too large|not text/);
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
});

test('refuses a directory target as denied', (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, 'dir'));
  refuses(() => writeProjectFile({ root, path: 'dir', text: 'x' }), 'denied', /regular file/);
});

test('expectedHash on a missing file is not_found, not conflict', (t) => {
  const root = project(t);
  refuses(() => writeProjectFile({ root, path: 'ghost.txt', text: 'x', expectedHash: 'a'.repeat(64) }), 'not_found', /does not exist/);
  assert.equal(fs.existsSync(path.join(root, 'ghost.txt')), false);
});

test('refuses a path outside the root and a symlink out', (t) => {
  const root = project(t);
  assert.throws(() => writeProjectFile({ root, path: '../x', text: 'x', create: true }), /outside|valid/);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-out-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => writeProjectFile({ root, path: 'link/x.txt', text: 'x', create: true }), /outside|symbolic/);
  assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false);
});

test('refuses to write through a final symlink', (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, 'real.txt'), 'one');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
  assert.throws(() => writeProjectFile({ root, path: 'alias.txt', text: 'two' }), /symbolic|denied/);
  assert.equal(fs.readFileSync(path.join(root, 'real.txt'), 'utf8'), 'one');
});

test('an overwrite keeps the existing file mode; a new file is 0600', (t) => {
  const root = project(t);
  const script = path.join(root, 'run.sh');
  fs.writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  writeProjectFile({ root, path: 'run.sh', text: '#!/bin/sh\necho hi\n' });
  assert.equal(fs.statSync(script).mode & 0o777, 0o755);
  writeProjectFile({ root, path: 'new.txt', text: 'x', create: true });
  assert.equal(fs.statSync(path.join(root, 'new.txt')).mode & 0o777, 0o600);
});

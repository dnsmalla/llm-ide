import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProjectFile, hashText } from '../routes/host-api/workspace-write.mjs';

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-write-')));
  fs.mkdirSync(path.join(root, 'src'));
  return root;
}

test('creates a new file and returns its hash', () => {
  const root = project();
  const out = writeProjectFile({ root, path: 'src/a.txt', text: 'one\n', create: true });
  assert.equal(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8'), 'one\n');
  assert.equal(out.hash, hashText('one\n'));
});

test('refuses a stale hash', () => {
  const root = project();
  const first = writeProjectFile({ root, path: 'a.txt', text: 'one', create: true });
  assert.throws(() => writeProjectFile({ root, path: 'a.txt', text: 'two', expectedHash: '0'.repeat(64) }), /changed/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one');
  assert.equal(first.size, 3);
});

test('mustNotExist refuses an existing file', () => {
  const root = project();
  writeProjectFile({ root, path: 'a.txt', text: 'one', create: true });
  assert.throws(() => writeProjectFile({ root, path: 'a.txt', text: 'two', mustNotExist: true }), /exists/);
});

test('mustNotExist cannot be combined with expectedHash', () => {
  const root = project();
  assert.throws(() => writeProjectFile({ root, path: 'a.txt', text: 'x', expectedHash: 'a'.repeat(64), mustNotExist: true }), /expectedHash|mustNotExist/);
});

test('refuses denied paths such as .git', () => {
  const root = project();
  assert.throws(() => writeProjectFile({ root, path: '.git/config', text: 'x', create: true }), /denied|not writable/);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});

test('refuses a path outside the root and a symlink out', () => {
  const root = project();
  assert.throws(() => writeProjectFile({ root, path: '../x', text: 'x', create: true }), /outside|valid/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-out-'));
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => writeProjectFile({ root, path: 'link/x.txt', text: 'x', create: true }), /outside|symbolic/);
});

test('refuses to write through a final symlink', () => {
  const root = project();
  fs.writeFileSync(path.join(root, 'real.txt'), 'one');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
  assert.throws(() => writeProjectFile({ root, path: 'alias.txt', text: 'two' }), /symbolic|denied/);
  assert.equal(fs.readFileSync(path.join(root, 'real.txt'), 'utf8'), 'one');
});

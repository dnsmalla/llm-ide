// Security gate + behavior for the agent's read-only repo file tools
// (buildReadableRoots / resolveReadablePath / handleListFiles / handleReadFile).
// The interesting cases are the REFUSALS: traversal, symlink escape, the secret
// denylist, and over-broad roots. Uses a workspace-root-only setup (no userId)
// so no DB is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const {
  buildReadableRoots, resolveReadablePath, handleListFiles, handleReadFile,
} = await import('../llm_agent/runtime/handlers/repo-files.mjs');

// Lay out a fake workspace + an "outside" tree a symlink will try to escape to.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-files-test-'));
const ws = path.join(base, 'workspace');
const outside = path.join(base, 'outside');
fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
fs.mkdirSync(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
fs.mkdirSync(path.join(ws, '.ssh'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(ws, 'README.md'), '# Project\nhello\n');
fs.writeFileSync(path.join(ws, 'docs', 'guide.md'), 'guide\n');
fs.writeFileSync(path.join(ws, '.env'), 'SECRET=abc\n');
fs.writeFileSync(path.join(ws, 'server.pem'), 'KEY\n');
fs.writeFileSync(path.join(ws, 'node_modules', 'pkg', 'index.js'), 'x\n');
fs.writeFileSync(path.join(ws, '.ssh', 'id_rsa'), 'PRIVATE\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
// A symlink inside the workspace pointing OUT — the escape attempt.
try { fs.symlinkSync(outside, path.join(ws, 'escape')); } catch { /* some CI can't symlink */ }

const roots = buildReadableRoots({ workspaceRoot: ws });

test('buildReadableRoots accepts a normal workspace dir', () => {
  assert.equal(roots.length, 1);
  assert.equal(fs.realpathSync(roots[0]), fs.realpathSync(ws));
});

test('buildReadableRoots refuses over-broad roots (/, $HOME)', () => {
  assert.deepEqual(buildReadableRoots({ workspaceRoot: '/' }), []);
  assert.deepEqual(buildReadableRoots({ workspaceRoot: os.homedir() }), []);
});

test('buildReadableRoots ignores a non-existent / non-dir root', () => {
  assert.deepEqual(buildReadableRoots({ workspaceRoot: path.join(base, 'nope') }), []);
  assert.deepEqual(buildReadableRoots({ workspaceRoot: path.join(ws, 'README.md') }), []);
});

test('list-files returns source files, excludes secrets + heavy dirs', () => {
  const { files } = handleListFiles({}, { roots });
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes(path.join('docs', 'guide.md')));
  // Excluded: secrets and heavy/secret dirs.
  assert.ok(!files.includes('.env'), '.env must be excluded');
  assert.ok(!files.includes('server.pem'), '*.pem must be excluded');
  assert.ok(!files.some((f) => f.startsWith('node_modules')), 'node_modules must be skipped');
  assert.ok(!files.some((f) => f.includes('.ssh')), '.ssh must be skipped');
  assert.ok(!files.some((f) => f.startsWith('escape')), 'symlinked dir contents must not be walked out');
});

test('list-files query filters by substring', () => {
  const { files } = handleListFiles({ query: 'readme' }, { roots });
  assert.deepEqual(files, ['README.md']);
});

test('read-file reads an allowed text file', () => {
  const r = handleReadFile({ path: 'README.md' }, { roots });
  assert.equal(r.error, undefined);
  assert.match(r.content, /# Project/);
});

test('read-file refuses a secret file inside the root (denylist)', () => {
  assert.ok(handleReadFile({ path: '.env' }, { roots }).error, '.env must be denied');
  assert.ok(handleReadFile({ path: 'server.pem' }, { roots }).error, '*.pem must be denied');
  assert.ok(handleReadFile({ path: '.ssh/id_rsa' }, { roots }).error, '.ssh/* must be denied');
});

test('read-file refuses path traversal', () => {
  assert.ok(handleReadFile({ path: '../outside/secret.txt' }, { roots }).error);
  assert.equal(resolveReadablePath('../outside/secret.txt', roots), null);
});

test('read-file refuses an absolute path outside the root', () => {
  assert.ok(handleReadFile({ path: path.join(outside, 'secret.txt') }, { roots }).error);
});

test('read-file refuses a symlink that escapes the root', () => {
  // 'escape' → outside/. Reading through it must be rejected because realpath
  // lands outside every allowed root. (Skipped if symlink creation failed.)
  if (!fs.existsSync(path.join(ws, 'escape'))) return;
  assert.ok(handleReadFile({ path: 'escape/secret.txt' }, { roots }).error,
    'symlink escape must be refused');
});

test('cleanup', () => {
  fs.rmSync(base, { recursive: true, force: true });
});

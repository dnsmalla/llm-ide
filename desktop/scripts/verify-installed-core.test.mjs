import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installedCoreProblems } from './verify-installed-core.mjs';

const SCRIPT = join(import.meta.dirname, 'verify-installed-core.mjs');
const tree = () => { const d = mkdtempSync(join(tmpdir(), 'vic-')); mkdirSync(join(d, 'root', 'extension', 'node_modules'), { recursive: true }); return d; };

test('a clean installed core passes', () => {
  const d = tree();
  assert.deepEqual(installedCoreProblems(d), []);
  assert.equal(spawnSync(process.execPath, [SCRIPT, d]).status, 0);
});

test('a bundled SDK claude binary fails with an ::error:: line', () => {
  const d = tree();
  const pkg = join(d, 'root', 'extension', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'claude.exe'), 'x');
  assert.ok(installedCoreProblems(d).length >= 2);
  const r = spawnSync(process.execPath, [SCRIPT, d], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /::error::/);
});

test('a wrong path is a failure, not a clean pass', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'no-such-core')]).status, 1);
});

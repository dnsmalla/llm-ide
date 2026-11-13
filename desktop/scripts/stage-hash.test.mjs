import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isStaged, sourceHash } from './stage-hash.mjs';

test('isStaged follows the same rules stage-core copies by', () => {
  assert.equal(isStaged('extension/server.mjs'), true);
  assert.equal(isStaged('extension/kb/migrations/001.sql'), true);
  assert.equal(isStaged('extension/kb/notes.md'), false, 'only .mjs/.json/.sql under kb/');
  assert.equal(isStaged('extension/tests/a.test.mjs'), false);
  assert.equal(isStaged('extension/src/sidepanel/App.tsx'), false);
  assert.equal(isStaged('extension/.env'), false);
  assert.equal(isStaged('extension/.env.example'), true);
  assert.equal(isStaged('desktop/anything'), false);
});

test('sourceHash changes with staged source and ignores what is never staged', () => {
  const repo = mkdtempSync(join(tmpdir(), 'stage-hash-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    mkdirSync(join(repo, 'extension', 'tests'), { recursive: true });
    mkdirSync(join(repo, 'schema', 'models'), { recursive: true });
    mkdirSync(join(repo, 'schema', 'host-api'), { recursive: true });
    writeFileSync(join(repo, 'extension', 'server.mjs'), 'a');
    writeFileSync(join(repo, 'extension', 'tests', 't.mjs'), 'a');
    writeFileSync(join(repo, 'schema', 'models', 'anthropic-models.json'), '{}');
    git('init', '-q');
    git('add', '-A');
    const base = sourceHash(repo);
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(sourceHash(repo), base, 'stable');
    writeFileSync(join(repo, 'extension', 'tests', 't.mjs'), 'changed');
    assert.equal(sourceHash(repo), base, 'a test file is not part of the stage');
    writeFileSync(join(repo, 'extension', 'server.mjs'), 'b');
    assert.notEqual(sourceHash(repo), base, 'an uncommitted edit to staged source counts');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

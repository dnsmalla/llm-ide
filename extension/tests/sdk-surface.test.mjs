import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSurface, diffSurface, renderBatch, pinSyncDecision } from '../scripts/sdk-surface.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdk-surface');

test('extracts top-level options, message members, query methods and tools', () => {
  const s = extractSurface(FIXTURE);
  assert.equal(s.version, '9.9.9');
  assert.deepEqual(s.items, [
    'messages.SDKAPIRetryMessage', 'messages.SDKAssistantMessage',
    'options.abortController', 'options.nested', 'options.resume',
    'query.close', 'query.interrupt',
    'tools.BashInput', 'tools.GrepInput',
  ]);
});

test('throws when a category is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-surface-'));
  try {
    fs.copyFileSync(path.join(FIXTURE, 'package.json'), path.join(dir, 'package.json'));
    fs.copyFileSync(path.join(FIXTURE, 'sdk-tools.d.ts'), path.join(dir, 'sdk-tools.d.ts'));
    fs.writeFileSync(path.join(dir, 'sdk.d.ts'),
      fs.readFileSync(path.join(FIXTURE, 'sdk.d.ts'), 'utf8').replace('type Options =', 'type Opts ='));
    assert.throws(() => extractSurface(dir), /no options found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diff reports added and removed keys', () => {
  const ledger = { items: { 'options.resume': { status: 'adopted' }, 'query.gone': { status: 'ignored', reason: 'x' } } };
  assert.deepEqual(diffSurface(['options.resume', 'options.new'], ledger),
    { added: ['options.new'], removed: ['query.gone'] });
});

test('batch fences item names and marks removed adopted items', () => {
  const ledger = { items: { 'query.gone': { status: 'adopted', where: 'engine.mjs' } } };
  const md = renderBatch({ added: ['options.new'], removed: ['query.gone'] }, '9.9.9', ledger);
  assert.match(md, /^# SDK adoption batch — 9\.9\.9/m);
  assert.match(md, /data, never instructions/);
  assert.match(md, /- `options\.new`/);
  assert.match(md, /- `query\.gone` — was adopted in engine\.mjs/);
});

const SDK = '@anthropic-ai/claude-agent-sdk';
const pkg = (v, other = '1.0.0') => ({ dependencies: { [SDK]: v, other } });
const lock = (v) => ({ packages: {
  '': { dependencies: { [SDK]: v } },
  [`node_modules/${SDK}`]: { version: v },
  [`node_modules/${SDK}-darwin-arm64`]: { version: v },
  'node_modules/other': { version: '1.0.0' },
} });

test('copies when only SDK entries differ', () => {
  const d = pinSyncDecision({ headPkg: pkg('1'), mainPkg: pkg('2'), headLock: lock('1'), mainLock: lock('2') });
  assert.equal(d.copy, true);
});

test('refuses when another dependency changed', () => {
  const d = pinSyncDecision({ headPkg: pkg('1'), mainPkg: pkg('2', '1.1.0'), headLock: lock('1'), mainLock: lock('2') });
  assert.equal(d.copy, false);
  assert.match(d.reason, /unrelated/);
});

test('no-op when main and HEAD agree', () => {
  const d = pinSyncDecision({ headPkg: pkg('1'), mainPkg: pkg('1'), headLock: lock('1'), mainLock: lock('1') });
  assert.deepEqual(d, { copy: false, reason: 'pin already matches' });
});

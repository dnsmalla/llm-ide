import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('throws on a message or tool union member that is not a bare identifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-surface-'));
  try {
    fs.copyFileSync(path.join(FIXTURE, 'package.json'), path.join(dir, 'package.json'));
    fs.copyFileSync(path.join(FIXTURE, 'sdk-tools.d.ts'), path.join(dir, 'sdk-tools.d.ts'));
    fs.writeFileSync(path.join(dir, 'sdk.d.ts'), fs.readFileSync(path.join(FIXTURE, 'sdk.d.ts'), 'utf8')
      .replace('SDKMessage = SDKAssistantMessage', 'SDKMessage = Wrap<SDKAssistantMessage>'));
    assert.throws(() => extractSurface(dir), /unexpected messages entry "Wrap<SDKAssistantMessage>"/);
    fs.copyFileSync(path.join(FIXTURE, 'sdk.d.ts'), path.join(dir, 'sdk.d.ts'));
    fs.writeFileSync(path.join(dir, 'sdk-tools.d.ts'), fs.readFileSync(path.join(FIXTURE, 'sdk-tools.d.ts'), 'utf8')
      .replace('| GrepInput', '| /* x */ GrepInput'));
    assert.throws(() => extractSurface(dir), /unexpected tools entry "\/\* x \*\/ GrepInput"/);
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

// The CLI end to end, against temp dirs only (the SDK_SURFACE_* overrides), so
// the real ledger and node_modules are never read or written.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sdk-surface.mjs');
const FIXTURE_ITEMS = extractSurface(FIXTURE).items;

function cli(t, { ledgerItems, args, mainPkg }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-surface-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ext = path.join(dir, 'head', 'extension');
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(path.join(ext, 'package.json'), JSON.stringify(pkg('1')));
  fs.writeFileSync(path.join(ext, 'package-lock.json'), JSON.stringify(lock('1')));
  const main = path.join(dir, 'main');
  fs.mkdirSync(path.join(main, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(main, 'extension', 'package.json'), JSON.stringify(mainPkg ?? pkg('1')));
  fs.writeFileSync(path.join(main, 'extension', 'package-lock.json'), JSON.stringify(lock('1')));
  const ledger = path.join(dir, 'sdk-surface.json');
  const items = Object.fromEntries(ledgerItems.map((k) => [k, { status: 'ignored', reason: 'x' }]));
  fs.writeFileSync(ledger, JSON.stringify({ sdkVersion: '9.9.9', items }));
  const batch = path.join(dir, 'out', 'BATCH.md');
  const resolved = args.map((a) => ({ $batch: batch, $main: main }[a] ?? a));
  const r = spawnSync(process.execPath, [CLI, ...resolved], {
    encoding: 'utf8',
    env: { ...process.env, SDK_SURFACE_SDK_DIR: FIXTURE, SDK_SURFACE_LEDGER: ledger, SDK_SURFACE_EXTENSION_DIR: ext },
  });
  return { code: r.status, stderr: r.stderr, batch: fs.existsSync(batch) ? fs.readFileSync(batch, 'utf8') : null };
}

test('cli diff: exit 0 writes a batch for unclassified items', (t) => {
  const r = cli(t, { ledgerItems: FIXTURE_ITEMS.slice(1), args: ['diff', '--batch', '$batch', '--main', '$main'] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.batch, /^# SDK adoption batch — 9\.9\.9/);
  assert.match(r.batch, new RegExp(`- \`${FIXTURE_ITEMS[0].replace('.', '\\.')}\``));
});

test('cli diff: exit 3 and no batch when everything is classified', (t) => {
  const r = cli(t, { ledgerItems: FIXTURE_ITEMS, args: ['diff', '--batch', '$batch'] });
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.batch, null);
});

test('cli diff: exit 4 and no batch when main has unrelated dependency edits', (t) => {
  const r = cli(t, { ledgerItems: [], mainPkg: pkg('2', '1.1.0'), args: ['diff', '--batch', '$batch', '--main', '$main'] });
  assert.equal(r.code, 4);
  assert.equal(r.batch, null);
  assert.match(r.stderr, /unrelated dependency edits/);
});

test('cli: exit 1 on bad usage', (t) => {
  const r = cli(t, { ledgerItems: [], args: [] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage:/);
});

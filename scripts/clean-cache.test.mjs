import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCleanup, applyCleanup, formatBytes } from './clean-cache.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 17);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-cache-'));
  const put = (rel, bytes = 10, ageDays = 0) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(bytes));
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(full, t, t);
  };
  return { root, put };
}

const rel = (root, items) => items.map((item) => path.relative(root, item.path)).sort();

test('plans the Rust debug caches but keeps the release build', () => {
  const { root, put } = fixture();
  put('desktop/src-tauri/target/debug/deps/a.rlib', 100);
  put('desktop/src-tauri/target/release/bundle/LLM-IDE.app/x', 50);
  put('desktop/workspace-core/target/debug/b', 20);
  const items = planCleanup(root, { now: NOW });
  assert.deepEqual(rel(root, items), ['desktop/src-tauri/target/debug', 'desktop/workspace-core/target']);
  assert.equal(items.find((item) => item.path.endsWith('debug')).bytes, 100);
});

test('keeps the newest backup pairs, deletes older pairs together and old migration snapshots', () => {
  const { root, put } = fixture();
  put('kb/backups/data-100.db', 10, 5);
  put('kb/backups/data-100.agent.db', 10, 5);
  put('kb/backups/data-200.db', 10, 3);
  put('kb/backups/data-300.db', 10, 1);
  put('kb/backups/data-300.agent.db', 10, 1);
  put('kb/backups/data.db.pre-0031-20260824-090626', 10, 90);
  put('kb/backups/data.db.pre-0031-20260824-090626-wal', 0, 90);
  put('kb/backups/data.db.pre-0050-20261110-090000', 10, 7);
  put('kb/backups/notes-by-hand.txt', 10, 400);
  const items = planCleanup(root, { now: NOW });
  assert.deepEqual(rel(root, items), [
    'kb/backups/data-100.agent.db',
    'kb/backups/data-100.db',
    'kb/backups/data.db.pre-0031-20260824-090626',
    'kb/backups/data.db.pre-0031-20260824-090626-wal',
  ]);
});

test('apply deletes exactly the plan and nothing else', () => {
  const { root, put } = fixture();
  put('desktop/workspace-helper/target/debug/c', 10);
  put('kb/backups/data-1.db', 10, 3);
  put('kb/backups/data-2.db', 10, 2);
  put('kb/backups/data-3.db', 10, 1);
  put('kb/data.db', 10);
  assert.deepEqual(applyCleanup(planCleanup(root, { now: NOW })), []);
  assert.equal(fs.existsSync(path.join(root, 'desktop/workspace-helper/target')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'kb/backups')).sort(), ['data-2.db', 'data-3.db']);
  assert.equal(fs.existsSync(path.join(root, 'kb/data.db')), true);
  assert.deepEqual(planCleanup(root, { now: NOW }), []);
});

test('a symlink inside a cache is not followed when sizing', () => {
  const { root, put } = fixture();
  put('outside/big', 1000);
  put('desktop/workspace-core/target/small', 5);
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'desktop/workspace-core/target/link'));
  const [item] = planCleanup(root, { now: NOW });
  assert.ok(item.bytes < 1000);
  applyCleanup([item]);
  assert.equal(fs.existsSync(path.join(root, 'outside/big')), true);
});

test('a symlinked parent folder is never deleted through', () => {
  const { root, put } = fixture();
  put('shared/debug/deps/a', 10);
  put('shared-backups/data-1.db', 10, 3);
  put('shared-backups/data-2.db', 10, 2);
  put('shared-backups/data-3.db', 10, 1);
  fs.mkdirSync(path.join(root, 'desktop/src-tauri'), { recursive: true });
  fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
  fs.symlinkSync(path.join(root, 'shared'), path.join(root, 'desktop/src-tauri/target'));
  fs.symlinkSync(path.join(root, 'shared-backups'), path.join(root, 'kb/backups'));
  assert.deepEqual(planCleanup(root, { now: NOW }), []);
});

test('formats sizes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(19.5 * 1024 ** 3), '19.5 GB');
});

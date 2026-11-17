#!/usr/bin/env node
// Report, and with --apply delete, the disk space a development checkout piles up:
//   - Rust debug build caches (desktop/src-tauri/target/debug, the workspace-* crates' target/).
//     They refill on every `tauri dev` / `cargo build` and reached ~19 GB here. The release
//     build (desktop/src-tauri/target/release, which holds the built LLM-IDE.app) is kept.
//   - Old database backups in kb/backups. The core never prunes that folder in the repo-kb
//     layout on purpose (core/config.mjs backupPrunePolicy), so it grows by ~90 MB a day.
//     Keeps the newest --keep pairs (default 2, same as the core) and deletes migration
//     snapshots (data.db.pre-NNNN-*) older than --pre-days (default 30).
// Dry run by default. Only these fixed paths under the repo root are ever touched.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_FILE_RE, DEFAULT_BACKUP_KEEP } from '../extension/kb/backup-retention.mjs';

export const RUST_CACHE_DIRS = [
  'desktop/src-tauri/target/debug',
  'desktop/workspace-helper/target',
  'desktop/workspace-core/target',
];
export const BACKUP_DIR = 'kb/backups';
// data.db.pre-0031-20260824-090626 plus its -wal / -shm siblings.
export const PRE_MIGRATION_RE = /^data\.db\.pre-\d+-[\d-]+(-wal|-shm)?$/;
const DAY_MS = 86_400_000;

/** Total bytes under `target`, never following symlinks. Missing paths count as 0. */
export function sizeOf(target) {
  let st;
  try { st = fs.lstatSync(target); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of fs.readdirSync(target)) total += sizeOf(path.join(target, name));
  return total;
}

/**
 * True when `rel` exists under `root` and no component of it is a symlink. A symlinked
 * `target` (e.g. on a shared build volume) or `kb/backups` is not ours to delete through.
 */
export function isRealPathUnder(root, rel) {
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    let st;
    try { st = fs.lstatSync(current); } catch { return false; }
    if (st.isSymbolicLink()) return false;
  }
  return true;
}

function backupItems(dir, keep, preDays, now) {
  const groups = new Map();
  const items = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (!st.isFile()) continue;
    const pair = name.match(BACKUP_FILE_RE);
    if (pair) {
      const g = groups.get(pair[1]) ?? { stamp: pair[1], files: [], mtimeMs: 0 };
      g.files.push({ full, bytes: st.size });
      g.mtimeMs = Math.max(g.mtimeMs, st.mtimeMs);
      groups.set(pair[1], g);
    } else if (PRE_MIGRATION_RE.test(name) && now - st.mtimeMs > preDays * DAY_MS) {
      items.push({ path: full, bytes: st.size, reason: `migration snapshot older than ${preDays} days` });
    }
  }
  // Same order as the core's pruneBackups: newest by mtime, then by stamp. A pair goes together.
  const ordered = [...groups.values()].sort((a, b) => (b.mtimeMs - a.mtimeMs) || (Number(b.stamp) - Number(a.stamp)));
  for (const old of ordered.slice(Math.max(1, Math.floor(keep)))) {
    for (const f of old.files) items.push({ path: f.full, bytes: f.bytes, reason: `backup beyond the newest ${keep}` });
  }
  return items;
}

/**
 * List what a cleanup would delete. Pure apart from reading the file system.
 * @param {string} root repo root
 * @param {{keep?: number, preDays?: number, now?: number}} [opts]
 * @returns {{path: string, bytes: number, reason: string}[]}
 */
export function planCleanup(root, { keep = DEFAULT_BACKUP_KEEP, preDays = 30, now = Date.now() } = {}) {
  const items = [];
  for (const rel of RUST_CACHE_DIRS) {
    const full = path.join(root, rel);
    if (isRealPathUnder(root, rel)) items.push({ path: full, bytes: sizeOf(full), reason: 'Rust build cache (rebuilt on demand)' });
  }
  if (!isRealPathUnder(root, BACKUP_DIR)) return items;
  return items.concat(backupItems(path.join(root, BACKUP_DIR), keep, preDays, now));
}

/** Delete every planned path. Returns the paths that could not be removed. */
export function applyCleanup(items) {
  const failed = [];
  for (const item of items) {
    try { fs.rmSync(item.path, { recursive: true, force: true }); } catch (err) { failed.push({ ...item, error: err.message }); }
  }
  return failed;
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function parseArgs(argv) {
  const opts = { apply: false, keep: DEFAULT_BACKUP_KEEP, preDays: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') opts.apply = true;
    else if (argv[i] === '--keep') opts.keep = Number(argv[++i]);
    else if (argv[i] === '--pre-days') opts.preDays = Number(argv[++i]);
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (!Number.isFinite(opts.keep) || opts.keep < 1) throw new Error('--keep must be a number >= 1');
  if (!Number.isFinite(opts.preDays) || opts.preDays < 0) throw new Error('--pre-days must be a number >= 0');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const items = planCleanup(root, opts);
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  for (const item of items) console.log(`${formatBytes(item.bytes).padStart(9)}  ${path.relative(root, item.path)}  (${item.reason})`);
  if (!items.length) { console.log('Nothing to clean.'); return; }
  if (!opts.apply) {
    console.log(`\n${formatBytes(total)} can be freed. Run \`make clean-cache APPLY=1\` to delete.`);
    return;
  }
  const failed = applyCleanup(items);
  for (const f of failed) console.error(`could not delete ${f.path}: ${f.error}`);
  const freed = total - failed.reduce((sum, f) => sum + f.bytes, 0);
  console.log(`\nFreed ${formatBytes(freed)}.`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

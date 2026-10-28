// Server backup retention (kb/backup-retention.mjs): keep the newest N
// data-<unix>.db backups, delete only matching regular files. Temp dirs only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneBackups } from '../kb/backup-retention.mjs';
import { backupKeepFromEnv, backupPrunePolicy } from '../core/config.mjs';

const ON = { allowed: true };

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-retain-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Five backups, data-1 oldest … data-5 newest (mtimes set explicitly).
function seedBackups() {
  const base = Date.now() - 10_000_000;
  for (let i = 1; i <= 5; i += 1) {
    const f = path.join(dir, `data-${1700000000 + i}.db`);
    fs.writeFileSync(f, `backup ${i}`);
    const t = new Date(base + i * 1000);
    fs.utimesSync(f, t, t);
  }
}

test('keeps the newest two and deletes the rest', () => {
  seedBackups();
  const r = pruneBackups(dir, 2, ON);
  assert.deepEqual(r.kept.sort(), ['data-1700000004.db', 'data-1700000005.db']);
  assert.equal(r.deleted.length, 3);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['data-1700000004.db', 'data-1700000005.db']);
});

test('subdirectories named like backups are never deleted or counted', () => {
  seedBackups();
  fs.mkdirSync(path.join(dir, 'data-9999999999.db'));
  fs.writeFileSync(path.join(dir, 'data-9999999999.db', 'inside.txt'), 'keep me');
  const r = pruneBackups(dir, 1, ON);
  assert.equal(r.skipped, null);
  assert.equal(r.deleted.length, 4);
  assert.ok(fs.existsSync(path.join(dir, 'data-9999999999.db', 'inside.txt')));
});

test('keep is never below one', () => {
  seedBackups();
  assert.equal(pruneBackups(dir, 0, ON).kept.length, 1);
});

test('a missing directory is a no-op', () => {
  const r = pruneBackups(path.join(dir, 'nope'), 2, ON);
  assert.deepEqual(r, { kept: [], deleted: [], failed: [], skipped: null });
});

test('LLMIDE_BACKUP_KEEP parses to an integer of at least 1, default 2', () => {
  assert.equal(backupKeepFromEnv(undefined), 2);
  assert.equal(backupKeepFromEnv(''), 2);
  assert.equal(backupKeepFromEnv('abc'), 2);
  assert.equal(backupKeepFromEnv('5'), 5);
  assert.equal(backupKeepFromEnv('2.9'), 2);
  assert.equal(backupKeepFromEnv('0'), 1);
  assert.equal(backupKeepFromEnv('-4'), 1);
});

test('nothing is deleted unless the policy allows it', () => {
  seedBackups();
  const r = pruneBackups(dir, 1, { allowed: false, reason: 'repo-kb layout never prunes' });
  assert.equal(r.skipped, 'repo-kb layout never prunes');
  assert.equal(fs.readdirSync(dir).length, 5);
});

test('a directory holding any other regular file is not pruned at all', () => {
  seedBackups();
  fs.writeFileSync(path.join(dir, 'MOVED-TO-APP-SUPPORT.txt'), 'a notice, not a backup');
  const r = pruneBackups(dir, 1, ON);
  assert.match(r.skipped, /other files/);
  assert.equal(r.deleted.length, 0);
  assert.equal(fs.readdirSync(dir).length, 6);
});

test('the prune policy: system always, custom only with both explicit settings, repo-kb never', () => {
  assert.equal(backupPrunePolicy({ location: 'system', backupDirSet: false, keepSet: false }).prune, true);
  assert.equal(backupPrunePolicy({ location: 'repo-kb', backupDirSet: true, keepSet: true }).prune, false);
  assert.equal(backupPrunePolicy({ location: 'custom', backupDirSet: false, keepSet: true }).prune, false);
  assert.equal(backupPrunePolicy({ location: 'custom', backupDirSet: true, keepSet: false }).prune, false);
  assert.equal(backupPrunePolicy({ location: 'custom', backupDirSet: true, keepSet: true }).prune, true);
});

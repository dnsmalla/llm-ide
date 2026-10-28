// Server backup retention (kb/backup-retention.mjs): keep the newest N
// data-<unix>.db backups, delete only matching regular files. Temp dirs only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneBackups } from '../kb/backup-retention.mjs';
import { backupKeepFromEnv } from '../core/config.mjs';

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
  const r = pruneBackups(dir, 2);
  assert.deepEqual(r.kept.sort(), ['data-1700000004.db', 'data-1700000005.db']);
  assert.equal(r.deleted.length, 3);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['data-1700000004.db', 'data-1700000005.db']);
});

test('deletes only files matching the backup name pattern and only regular files', () => {
  seedBackups();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
  fs.writeFileSync(path.join(dir, 'data-x.db'), 'keep me');
  fs.writeFileSync(path.join(dir, 'data-1700000001.db.bak'), 'keep me');
  fs.writeFileSync(path.join(dir, 'data-1700000001.db-wal'), 'keep me');
  fs.mkdirSync(path.join(dir, 'data-9999999999.db'));
  fs.writeFileSync(path.join(dir, 'data-9999999999.db', 'inside.txt'), 'keep me');
  pruneBackups(dir, 1);
  const left = fs.readdirSync(dir).sort();
  for (const keep of ['notes.txt', 'data-x.db', 'data-1700000001.db.bak', 'data-1700000001.db-wal', 'data-9999999999.db']) {
    assert.ok(left.includes(keep), `${keep} must survive`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'data-9999999999.db', 'inside.txt')));
  assert.equal(left.filter((n) => /^data-\d+\.db$/.test(n) && fs.statSync(path.join(dir, n)).isFile()).length, 1);
});

test('keep is never below one', () => {
  seedBackups();
  assert.equal(pruneBackups(dir, 0).kept.length, 1);
});

test('a missing directory is a no-op', () => {
  const r = pruneBackups(path.join(dir, 'nope'), 2);
  assert.deepEqual(r, { kept: [], deleted: [], failed: [] });
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

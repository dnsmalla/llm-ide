// scripts/backup.mjs: backs up the DB it is given (the live DB by default) and
// reports which data location that DB came from. Temp files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runBackup } from '../scripts/backup.mjs';

test('runBackup copies an explicit DB and reports it as custom', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-script-'));
  try {
    const src = path.join(dir, 'src.db');
    const db = new Database(src);
    db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1), (2), (3);');
    db.close();
    const out = path.join(dir, 'out', 'copy.db');
    const r = await runBackup({ dbPath: src, outPath: out });
    assert.equal(r.location, 'custom');
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    const copy = new Database(out, { readonly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM t').get().n, 3);
    copy.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

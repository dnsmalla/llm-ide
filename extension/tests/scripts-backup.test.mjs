import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { runBackup } from '../scripts/backup.mjs';

function makeDbFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-backup-'));
  const dbPath = path.join(dir, 'data.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    INSERT INTO notes (body) VALUES ('first row');
  `);
  db.close();
  return { dir, dbPath };
}

function cleanupFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('backup script happy path creates a non-empty backup with checksum', async () => {
  const { dir, dbPath } = makeDbFixture();
  try {
    const outPath = path.join(dir, 'backup.db');
    const result = await runBackup({ dbPath, outPath });
    assert.equal(result.outPath, outPath);
    assert.ok(result.bytes > 0);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);

    const backupDb = new Database(outPath, { readonly: true, fileMustExist: true });
    const row = backupDb.prepare('SELECT body FROM notes').get();
    backupDb.close();
    assert.equal(row.body, 'first row');
  } finally {
    cleanupFixture(dir);
  }
});

test('backup script refuses to overwrite an existing output file without --force', async () => {
  const { dir, dbPath } = makeDbFixture();
  try {
    const outPath = path.join(dir, 'existing.db');
    fs.writeFileSync(outPath, 'placeholder');
    await assert.rejects(
      () => runBackup({ dbPath, outPath }),
      /Refusing to overwrite existing backup/,
    );
  } finally {
    cleanupFixture(dir);
  }
});

test('backup script overwrites an existing output file when --force is passed', async () => {
  const { dir, dbPath } = makeDbFixture();
  try {
    const outPath = path.join(dir, 'existing.db');
    fs.writeFileSync(outPath, 'placeholder');
    const result = await runBackup({ dbPath, outPath, force: true });
    assert.equal(result.outPath, outPath);
    assert.ok(result.bytes > 'placeholder'.length);

    const backupDb = new Database(outPath, { readonly: true, fileMustExist: true });
    const count = backupDb.prepare('SELECT COUNT(*) AS n FROM notes').get();
    backupDb.close();
    assert.equal(count.n, 1);
  } finally {
    cleanupFixture(dir);
  }
});

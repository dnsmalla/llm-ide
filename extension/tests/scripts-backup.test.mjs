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
test('backup script includes the sibling agent.db as a pair', async () => {
  const { dir, dbPath } = makeDbFixture();
  try {
    const agentDb = path.join(dir, 'agent.db');
    const a = new Database(agentDb);
    a.exec("CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, outcome TEXT); INSERT INTO agent_runs (outcome) VALUES ('ok');");
    a.close();
    const outPath = path.join(dir, 'backup.db');
    const result = await runBackup({ dbPath, outPath });
    assert.equal(result.agentPath, path.join(dir, 'backup.agent.db'));
    assert.ok(result.agentBytes > 0);
    assert.match(result.agentSha256, /^[a-f0-9]{64}$/);
    const copy = new Database(result.agentPath, { readonly: true, fileMustExist: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 1);
    copy.close();
  } finally {
    cleanupFixture(dir);
  }
});

test('R-034 #16: an optional off-host copy is attempted and its failure never loses the local backup', async () => {
  const { dir, dbPath } = makeDbFixture();
  try {
    const outPath = path.join(dir, 'backup.db');
    const seen = [];
    const ok = await runBackup({
      dbPath, outPath, offHostTarget: 'backup.example.com:/srv/llmide',
      offHostCopy: async (files, target) => { seen.push({ files, target }); },
    });
    assert.deepEqual(seen, [{ files: [outPath], target: 'backup.example.com:/srv/llmide' }]);
    assert.equal(ok.offHost.ok, true);
    assert.ok(fs.existsSync(outPath));

    const outPath2 = path.join(dir, 'backup2.db');
    const failed = await runBackup({
      dbPath, outPath: outPath2, offHostTarget: 'backup.example.com:/srv/llmide',
      offHostCopy: async () => { throw new Error('rsync exited 23'); },
    });
    assert.equal(failed.offHost.ok, false);
    assert.match(failed.offHost.error, /rsync exited 23/);
    assert.ok(fs.existsSync(outPath2), 'the local backup still exists');
  } finally {
    cleanupFixture(dir);
  }
});

test('R-034 #16: pruneSiblingBackups keeps the newest N pairs and nothing else', async () => {
  const { pruneSiblingBackups } = await import('../scripts/backup.mjs');
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'bak-prune-'));
  const db = pathMod.join(dir, 'data.db');
  const names = ['data.db', 'data.db.failed-x.db', 'other.txt'];
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) {
    names.push(`data.db.bak-${d}T03-00-00.000Z.db`, `data.db.bak-${d}T03-00-00.000Z.agent.db`);
  }
  for (const n of names) fsMod.writeFileSync(pathMod.join(dir, n), 'x');
  await pruneSiblingBackups(db, 2);
  const left = fsMod.readdirSync(dir).sort();
  assert.ok(!left.some((n) => n.includes('2026-11-01')), 'the oldest pair is gone');
  assert.ok(left.includes('data.db.bak-2026-11-03T03-00-00.000Z.agent.db'));
  assert.ok(left.includes('data.db.bak-2026-11-02T03-00-00.000Z.db'));
  for (const keep of ['data.db', 'data.db.failed-x.db', 'other.txt']) assert.ok(left.includes(keep), keep);
});

// Tests for kb/db.mjs backupTo() — VACUUM INTO with a bound parameter
// instead of string interpolation (see 2026-07-02 review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_db-backup-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const Database = (await import('better-sqlite3')).default;

test('backupTo produces a self-consistent copy of the live DB', () => {
  kb.getDb(); // open + migrate
  const target = path.join(__dirname, '_db-backup-out.db');
  try { fs.unlinkSync(target); } catch { /* ok */ }
  kb.backupTo(target);
  assert.ok(fs.existsSync(target), 'backup file exists');
  const copy = new Database(target, { readonly: true });
  const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  copy.close();
  fs.unlinkSync(target);
  assert.ok(tables.includes('users'), `expected users table in backup, got: ${tables.join(',')}`);
});

test('backupTo works when the target path contains a single quote', () => {
  kb.getDb();
  const dir = path.join(__dirname, "_bk'dir");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'data.db');
  kb.backupTo(target);
  assert.ok(fs.existsSync(target), 'backup created despite quote in path');
  fs.rmSync(dir, { recursive: true, force: true });
});

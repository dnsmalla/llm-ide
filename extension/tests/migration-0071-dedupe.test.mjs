// R-021 #3: a DB written before the canonical-root code fix can hold two projects on one folder (exactly the
// hijack state 25927430 allowed). 0071 must not make the core unbootable: the oldest row keeps the folder link,
// the duplicate loses only its root (id, name and grants stay), then the unique index applies.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-mig-0071-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const kb = await import('../kb/db.mjs');
const SQL = fs.readFileSync(new URL('../kb/migrations/0071_project_root_unique.sql', import.meta.url), 'utf8');

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('0071 dedupes an existing duplicate root instead of failing the index', () => {
  const db = kb.getDb();
  db.exec('DROP INDEX IF EXISTS idx_projects_root');
  db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('u1','a@b.c','A','x','user','active')").run();
  db.prepare("INSERT INTO projects (id, name, root, created_by, created_at, updated_at) VALUES ('p-old','Old','/r/same','u1','2026-01-01 00:00:00','2026-01-02 00:00:00')").run();
  db.prepare("INSERT INTO projects (id, name, root, created_by, created_at, updated_at) VALUES ('p-new','New','/r/same','u1','2026-02-01 00:00:00','2026-03-01 00:00:00')").run();
  db.prepare("INSERT INTO project_members (user_id, project_id, role, max_mode, usd_cap_month, granted_by) VALUES ('u1','p-new','owner','execute',0,'u1')").run();

  db.exec(SQL);

  const rows = db.prepare("SELECT id, root FROM projects ORDER BY id").all();
  assert.deepEqual(rows, [{ id: 'p-new', root: null }, { id: 'p-old', root: '/r/same' }], 'the oldest keeps the folder, the duplicate keeps its row');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = 'p-new'").get().n, 1, 'grants are untouched');
  assert.throws(() => db.prepare("INSERT INTO projects (id, name, root) VALUES ('p-third','T','/r/same')").run(), /UNIQUE/);
});

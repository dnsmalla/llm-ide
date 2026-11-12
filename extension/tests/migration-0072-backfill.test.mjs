// R-023 #4/#5: 0072's owner backfill must use the indexed bare columns (an O(n²) backfill blocks boot past the
// desktop's 20 s deadline) and plans store their id in FTS `entity_id` (a pre-upgrade plan must stay searchable).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applyMigrations } from '../kb/migrations.mjs';
import { budget } from './helpers/perf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL = path.join(HERE, '../kb/migrations');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-mig72-'));
const upTo71 = path.join(dir, 'migrations');
fs.mkdirSync(upTo71);
for (const f of fs.readdirSync(ALL)) {
  if (/^0072_/.test(f) || !f.endsWith('.sql')) continue;
  fs.copyFileSync(path.join(ALL, f), path.join(upTo71, f));
}
const SQL = fs.readFileSync(path.join(ALL, '0072_search_user_column.sql'), 'utf8');
const dbFile = path.join(dir, 'kb.db');
const db = new Database(dbFile);
applyMigrations(db, { dir: upTo71 });
db.pragma('foreign_keys = ON');
db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('u1','a@x.y','A','x','user','active')").run();
db.prepare("INSERT INTO meetings (id, user_id, title, date) VALUES ('m1','u1','meeting','2026-11-08')").run();
db.prepare("INSERT INTO entities (id, meeting_id, user_id, kind, text) VALUES ('e1','m1','u1','action','action')").run();
db.prepare("INSERT INTO plans (id, meeting_id, user_id, title) VALUES ('pl1','m1','u1','Plan title')").run();
db.prepare("INSERT INTO plan_tasks (id, plan_id, user_id, title) VALUES ('t1','pl1','u1','Task title')").run();
db.prepare("INSERT INTO outcomes (id, task_id, user_id, provider, ref, state) VALUES (1,'t1','u1','github','r','done')").run();
db.prepare("INSERT INTO sources (id, kind, ref, chunk_idx, title, body, user_id) VALUES (1,'code','/r/a.mjs',0,'code','code','u1')").run();
db.prepare("INSERT INTO note_index (id, user_id, note_key, kind, title, date, body_text, content_hash, mtime_ms) VALUES (1,'u1','n.md','meeting','Note','2026-11-08','note','h',0)").run();

after(() => {
  try { db.close(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('0072 stamps every kind, including plans (whose id lives in entity_id)', () => {
  db.exec(SQL);
  const owners = db.prepare("SELECT kind, user_id FROM search ORDER BY kind").all();
  assert.ok(owners.length >= 7);
  for (const r of owners) assert.equal(r.user_id, 'u1', `${r.kind} has an owner`);
  const plan = db.prepare("SELECT COUNT(*) AS n FROM search WHERE kind = 'plan' AND user_id = 'u1'").get();
  assert.equal(plan.n, 1, 'a pre-upgrade plan is owned and therefore searchable');
});

test('the backfill is linear: 10,000 source rows migrate well under 20 s', () => {
  const big = new Database(path.join(dir, 'big.db'));
  applyMigrations(big, { dir: upTo71 });
  big.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('u1','a@x.y','A','x','user','active')").run();
  const ins = big.prepare("INSERT INTO sources (kind, ref, chunk_idx, title, body, user_id) VALUES ('code', ?, 0, 't', 'b', 'u1')");
  big.transaction(() => { for (let i = 0; i < 10_000; i += 1) ins.run(`/r/f${i}.mjs`); })();
  assert.equal(big.prepare("SELECT COUNT(*) AS n FROM search WHERE kind = 'code'").get().n, 10_000);
  const t0 = Date.now();
  big.exec(SQL);
  const ms = Date.now() - t0;
  assert.ok(ms < budget(20_000), `backfill took ${ms} ms`);
  assert.equal(big.prepare("SELECT COUNT(*) AS n FROM search WHERE kind = 'code' AND user_id = 'u1'").get().n, 10_000);
  big.close();
});

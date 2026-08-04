import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_scip-connector-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

const db = await import('../kb/db.mjs');
const { ingestSources } = await import('../kb/sources.mjs');
const users = await import('../server/users.mjs');
const { indexScip } = await import('../connectors/scip.mjs');

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'scip', 'sample.scip.json'), 'utf8'));
const fakeLoad = async () => fixture; // no real scip CLI needed

let U, REPO;
test('setup', () => {
  U = users.registerUser(db.getDb(), {
    email: `scip-conn-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c',
  }).id;
  REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-repo-'));
});

test('indexScip writes scip symbol rows + graph nodes/edges and returns counts', async () => {
  const res = await indexScip(U, REPO, 'ignored.scip', { load: fakeLoad });
  assert.equal(res.symbols, 4, 'one sources row per node');
  assert.equal(res.nodes, 4);
  assert.ok(res.edges >= 1, 'reference edges persisted');
  // symbol rows are kind=code, flagged source=scip
  const scipRows = db.getDb().prepare(
    "SELECT ref FROM sources WHERE user_id=? AND meta LIKE '%\"source\":\"scip\"%'",
  ).all(U);
  assert.equal(scipRows.length, 4);
  // graph tables populated
  assert.equal(db.getCodeGraphSnapshot(U, REPO).nodes.length, 4);
});

test('indexScip replace clears prior scip rows + graph but keeps chunks', async () => {
  // Seed a chunk row under the same repo that must survive replace.
  ingestSources(U, [
    { kind: 'code', ref: path.join(REPO, 'chunk.ts'), chunkIdx: 0, title: 'chunk', body: 'plain', meta: {} },
  ]);
  await indexScip(U, REPO, 'ignored.scip', { replace: true, load: fakeLoad });
  // chunk row still present
  const chunk = db.getDb().prepare("SELECT ref FROM sources WHERE user_id=? AND ref=?").get(U, path.join(REPO, 'chunk.ts'));
  assert.ok(chunk, 'chunk row survives replace');
  // scip rows present exactly once (no duplication from re-ingest)
  const scipCount = db.getDb().prepare(
    "SELECT COUNT(*) n FROM sources WHERE user_id=? AND meta LIKE '%\"source\":\"scip\"%'",
  ).get(U).n;
  assert.equal(scipCount, 4);
});

test('cleanup', () => {
  db.closeDb();
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
});

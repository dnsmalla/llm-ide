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

test('indexScip replace clears the OLD graph (not a merge) — proves clearCodeGraph ran', async () => {
  // After the prior tests, REPO's graph holds the 4-node sample fixture.
  // Re-ingest with a DIFFERENT 2-node fixture and assert the snapshot reflects
  // ONLY the new nodes/edges — if clearCodeGraph were a no-op, we'd see 6 nodes.
  const fixture2 = {
    documents: [{
      relative_path: 'src/only.ts',
      symbols: [
        { symbol: 'scip-typescript npm src only Alpha()', display_name: 'Alpha', relationships: [] },
        { symbol: 'scip-typescript npm src only Beta()', display_name: 'Beta', relationships: [
          { symbol: 'scip-typescript npm src only Alpha()', is_reference: true },
        ] },
      ],
      occurrences: [
        { symbol: 'scip-typescript npm src only Alpha()', symbol_roles: 1, range: [1, 0, 3], enclosing_range: [1, 0, 2, 1] },
        { symbol: 'scip-typescript npm src only Beta()', symbol_roles: 1, range: [5, 0, 4], enclosing_range: [5, 0, 7, 1] },
      ],
    }],
  };
  const fakeLoad2 = async () => fixture2;
  const res = await indexScip(U, REPO, 'ignored.scip', { replace: true, load: fakeLoad2 });
  assert.equal(res.nodes, 2, 'new fixture has 2 nodes');
  const snap = db.getCodeGraphSnapshot(U, REPO);
  assert.equal(snap.nodes.length, 2, 'graph holds ONLY the 2 new nodes, not a merge with old 4');
  const titles = snap.nodes.map((n) => n.title).sort();
  assert.deepEqual(titles, ['Alpha', 'Beta'], 'new graph reflects the replaced node set');
});

test('replace on a repo with an underscore in its path does not delete a sibling repo\'s scip rows', async () => {
  // Regression for the LIKE-wildcard escaping bug: repoA's path contains `_`,
  // which without ESCAPE would match ANY character at that position — including
  // repoB, whose path is identical except for that one character.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-sibling-'));
  const repoA = path.join(base, 'my_app');
  const repoB = path.join(base, 'myXapp');
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  try {
    await indexScip(U, repoA, 'ignored.scip', { load: fakeLoad });
    await indexScip(U, repoB, 'ignored.scip', { load: fakeLoad });
    assert.equal(db.getCodeGraphSnapshot(U, repoB).nodes.length, 4, 'repoB graph seeded');

    await indexScip(U, repoA, 'ignored.scip', { replace: true, load: fakeLoad });

    const repoBScipRows = db.getDb().prepare(
      "SELECT ref FROM sources WHERE user_id=? AND ref LIKE ? AND meta LIKE '%\"source\":\"scip\"%'",
    ).all(U, `${repoB}${path.sep}%`);
    assert.equal(repoBScipRows.length, 4, 'repoB scip rows survive repoA replace');
    assert.equal(db.getCodeGraphSnapshot(U, repoB).nodes.length, 4, 'repoB graph untouched');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('cleanup', () => {
  db.closeDb();
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
});

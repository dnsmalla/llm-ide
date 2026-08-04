import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-graph-store-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

const db = await import('../kb/db.mjs');
const { ingestSources } = await import('../kb/sources.mjs');
const users = await import('../server/users.mjs');

const U = users.registerUser(db.getDb(), {
  email: `scip-store-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 's',
}).id;
const REPO = '/repo/x';

const CG = {
  nodes: [
    { id: 's A', title: 'A', kind: 'classType', metadata: { source_file: 'a.ts', line: 'L1', language: 'TypeScript' } },
    { id: 's B', title: 'B', kind: 'function', metadata: { source_file: 'b.ts', line: 'L2', language: 'TypeScript' } },
    { id: 's C', title: 'C', kind: 'function', metadata: { source_file: 'c.ts', line: 'L3', language: 'TypeScript' } },
  ],
  edges: [
    { fromId: 's B', toId: 's A', kind: 'references', confidence: 'EXTRACTED' },
    { fromId: 's C', toId: 's B', kind: 'references', confidence: 'EXTRACTED' },
  ],
};

test('writeCodeGraph upserts nodes and edges, getCodeGraphSnapshot reads them back', () => {
  db.writeCodeGraph(U, REPO, CG);
  const snap = db.getCodeGraphSnapshot(U, REPO);
  assert.equal(snap.nodes.length, 3);
  assert.equal(snap.edges.length, 2);
  // idempotent re-write does not duplicate
  db.writeCodeGraph(U, REPO, CG);
  assert.equal(db.getCodeGraphSnapshot(U, REPO).nodes.length, 3);
});

test('clearCodeGraph empties both tables for the repo', () => {
  db.clearCodeGraph(U, REPO);
  const snap = db.getCodeGraphSnapshot(U, REPO);
  assert.equal(snap.nodes.length, 0);
  assert.equal(snap.edges.length, 0);
});

test('expandSymbols does a 2-hop BFS over edges (user-scoped)', () => {
  db.writeCodeGraph(U, REPO, CG);
  // C -> B -> A : 1 hop from C is B, 2 hops reaches A.
  const one = db.expandSymbols(U, ['s C'], { hops: 1 });
  assert.ok(one.includes('s B') && !one.includes('s A'));
  const two = db.expandSymbols(U, ['s C'], { hops: 2 });
  assert.ok(two.includes('s B') && two.includes('s A'));
});

test('findCodeSymbolIds + hydrateSymbols round-trip by title query', () => {
  const ids = db.findCodeSymbolIds(U, 'A', 10);
  assert.ok(ids.includes('s A'));
  const hydrated = db.hydrateSymbols(U, ids);
  assert.ok(hydrated.some((n) => n.symbol_id === 's A' && n.kind === 'classType'));
});

test('deleteScipSources removes only scip rows, leaving chunks intact', () => {
  // Seed a chunk row (no source=scip) and a scip row for the same repo prefix.
  ingestSources(U, [
    { kind: 'code', ref: `${REPO}/chunk.ts`, chunkIdx: 0, title: 'chunk', body: 'plain chunk', meta: {} },
    { kind: 'code', ref: `${REPO}/a.ts:L1`, chunkIdx: 0, title: 'A', body: 'classType', meta: { source: 'scip', symbol_id: 's A' } },
  ]);
  const removed = db.deleteScipSources(U, REPO);
  assert.equal(removed, 1, 'only the scip row removed');
  const remaining = db.getDb().prepare("SELECT ref FROM sources WHERE user_id=? AND ref LIKE ?").all(U, `${REPO}/%`);
  assert.deepEqual(remaining.map((r) => r.ref), [`${REPO}/chunk.ts`], 'chunk row survives');
});

test('user scoping: a second user cannot see the first user graph', () => {
  const U2 = users.registerUser(db.getDb(), {
    email: `scip-store2-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 's2',
  }).id;
  db.writeCodeGraph(U, REPO, CG);
  assert.equal(db.getCodeGraphSnapshot(U2, REPO).nodes.length, 0, "U2 sees none of U's graph");
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
});

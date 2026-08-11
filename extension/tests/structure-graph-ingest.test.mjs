// End-to-end for the structural code-graph ingest: the Mac app's
// StructureGraphBuilder output → /kb/ingest-code-graph → code_graph_* →
// findRelatedSymbols. Before this path existed the tables had no product-side
// writer at all (only a hand-produced SCIP index, which nothing generates), so
// the compiler-derived half of code-sync's grounding always came back empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_structure-graph-ingest-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { findRelatedSymbols } = await import('../graphkit/index.mjs');
const {
  ingestStructureGraph, normalizeNode, normalizeEdge, MAX_NODES_PER_REQUEST,
} = await import('../connectors/structure-graph.mjs');
const { GRAPH_SOURCE_SCIP, GRAPH_SOURCE_STRUCTURE } = await import('../kb/code-graph.mjs');

const U = users.registerUser(db.getDb(), {
  email: `sgi-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 's',
}).id;

const REPO = '/repo/structure';

// Shaped exactly like GraphKit's StructureGraphBuilder output.
const macGraph = {
  nodes: [
    { id: 'file:kb/db.mjs', title: 'db.mjs', kind: 'file',
      metadata: { source_file: 'kb/db.mjs', language: 'javascript', loc: '900' } },
    { id: 'function:kb/db.mjs:backupTo', title: 'backupTo', kind: 'function',
      metadata: { source_file: 'kb/db.mjs', line: 'L120', kind: 'function' } },
    { id: 'function:kb/db.mjs:restoreFrom', title: 'restoreFrom', kind: 'function',
      metadata: { source_file: 'kb/db.mjs', line: 'L160', kind: 'function' } },
  ],
  edges: [
    { fromId: 'file:kb/db.mjs', toId: 'function:kb/db.mjs:backupTo', kind: 'contains', confidence: 'extracted' },
    { fromId: 'function:kb/db.mjs:backupTo', toId: 'function:kb/db.mjs:restoreFrom', kind: 'calls', confidence: 'inferred' },
  ],
};

test('ingest stores nodes and edges and reports counts', () => {
  const res = ingestStructureGraph(U, REPO, macGraph, { replace: true });
  assert.equal(res.nodes, 3);
  assert.equal(res.edges, 2);
  assert.equal(res.droppedNodes, 0);
  assert.equal(res.droppedEdges, 0);
  assert.equal(res.replaced, true);
});

test('findRelatedSymbols now resolves a real symbol and its call target', () => {
  const syms = findRelatedSymbols(U, 'backupTo', { hops: 1, limit: 10 });
  const ids = syms.map((s) => s.symbol_id);
  assert.ok(ids.includes('function:kb/db.mjs:backupTo'), 'seed symbol found');
  // `calls` is traversed so the agent sees what the seed reaches.
  assert.ok(ids.includes('function:kb/db.mjs:restoreFrom'), 'call target expanded');
});

test('hydrated symbols carry repo_id + relative source_file for path resolution', () => {
  const [sym] = findRelatedSymbols(U, 'backupTo', { hops: 0, limit: 1 });
  assert.equal(sym.repo_id, REPO);
  assert.equal(sym.source_file, 'kb/db.mjs');
  assert.equal(sym.line, 120);
});

test('re-ingest with replace drops symbols whose files are gone', () => {
  ingestStructureGraph(U, REPO, {
    nodes: [macGraph.nodes[0], macGraph.nodes[1]],
    edges: [macGraph.edges[0]],
  }, { replace: true });
  const ids = findRelatedSymbols(U, 'restoreFrom', { hops: 1, limit: 10 }).map((s) => s.symbol_id);
  assert.ok(!ids.includes('function:kb/db.mjs:restoreFrom'), 'deleted symbol is gone');
  ingestStructureGraph(U, REPO, macGraph, { replace: true }); // restore for later tests
});

test('a batch WITHOUT replace adds to the existing graph', () => {
  ingestStructureGraph(U, REPO, {
    nodes: [{ id: 'function:kb/db.mjs:vacuum', title: 'vacuum', kind: 'function',
              metadata: { source_file: 'kb/db.mjs', line: 'L200' } }],
    edges: [],
  }, { replace: false });
  const ids = findRelatedSymbols(U, 'vacuum', { hops: 0, limit: 5 }).map((s) => s.symbol_id);
  assert.ok(ids.includes('function:kb/db.mjs:vacuum'));
  // The first batch's nodes survived — replace must not be implied.
  const kept = findRelatedSymbols(U, 'backupTo', { hops: 0, limit: 5 }).map((s) => s.symbol_id);
  assert.ok(kept.includes('function:kb/db.mjs:backupTo'));
});

test('a structural replace leaves a SCIP graph for the same repo intact', () => {
  db.writeCodeGraph(U, REPO, {
    nodes: [{ id: 'scip npm foo Widget#', title: 'Widget', kind: 'classType',
              metadata: { source_file: 'w.ts', line: 'L1' } }],
    edges: [],
  }, { source: GRAPH_SOURCE_SCIP });

  ingestStructureGraph(U, REPO, macGraph, { replace: true });

  const ids = findRelatedSymbols(U, 'Widget', { hops: 0, limit: 5 }).map((s) => s.symbol_id);
  assert.ok(ids.includes('scip npm foo Widget#'),
    'a structural regeneration must not wipe the SCIP-sourced graph');
});

test('normalizeNode refuses traversal and absolute source_file paths', () => {
  assert.equal(normalizeNode({ id: 'a', metadata: { source_file: '../../etc/passwd' } })
    .metadata.source_file, '');
  assert.equal(normalizeNode({ id: 'a', metadata: { source_file: '/etc/passwd' } })
    .metadata.source_file, '');
  assert.equal(normalizeNode({ id: 'a', metadata: { source_file: 'src/ok.ts' } })
    .metadata.source_file, 'src/ok.ts');
});

test('normalizeNode/Edge drop unusable entries instead of storing junk', () => {
  assert.equal(normalizeNode({ title: 'no id' }), null);
  assert.equal(normalizeNode(null), null);
  assert.equal(normalizeEdge({ fromId: 'a', kind: 'calls' }), null);
  assert.equal(normalizeEdge({ fromId: 'a', toId: 'b' }), null);
  // A bare numeric line is accepted and normalised to the "L<n>" form.
  assert.equal(normalizeNode({ id: 'a', metadata: { line: 42 } }).metadata.line, 'L42');
});

test('drops are reported so a client can tell a partial write from a clean one', () => {
  const res = ingestStructureGraph(U, REPO, {
    nodes: [{ id: 'ok:1', title: 'ok' }, { title: 'missing id' }],
    edges: [{ fromId: 'ok:1', toId: 'ok:1', kind: 'calls' }, { fromId: 'x' }],
  }, { replace: false });
  assert.equal(res.droppedNodes, 1);
  assert.equal(res.droppedEdges, 1);
});

test('an oversized batch is rejected rather than silently truncated', () => {
  const nodes = Array.from({ length: MAX_NODES_PER_REQUEST + 1 },
    (_, i) => ({ id: `n${i}`, title: `n${i}` }));
  assert.throws(() => ingestStructureGraph(U, REPO, { nodes, edges: [] }, { replace: false }),
    /too many nodes/);
});

test('graph rows are tagged with their producer', () => {
  const rows = db.getDb().prepare(
    'SELECT DISTINCT source FROM code_graph_nodes WHERE user_id=? AND repo_id=? ORDER BY source',
  ).all(U, REPO).map((r) => r.source);
  assert.deepEqual(rows, [GRAPH_SOURCE_SCIP, GRAPH_SOURCE_STRUCTURE].sort());
});

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
});

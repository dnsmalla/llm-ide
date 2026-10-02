// repo_id is a path, and macOS paths are case-INSENSITIVE: the same clone
// opened once as `~/Desktop/LLM` and once as `~/Desktop/llm` was graphed
// under two repo_ids, splitting its symbols between them and leaving the
// stale copy behind forever. The structural ingest now stores the on-disk
// spelling, drops a case-variant copy of the same directory on a replace,
// and workspace scoping matches whichever spelling the client sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-graph-path-case-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { ingestStructureGraph } = await import('../connectors/structure-graph.mjs');
const { writeCodeGraph, workspaceRepoIds, GRAPH_SOURCE_STRUCTURE } = await import('../kb/code-graph.mjs');
const { canonicalPathCase } = await import('../core/path-case.mjs');

const U = users.registerUser(db.getDb(), {
  email: `pc-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'p',
}).id;

const ROOT = fs.mkdtempSync(path.join(__dirname, '_pc-'));
const REPO = path.join(ROOT, 'CaseRepo');
fs.mkdirSync(REPO);
const LOWER = path.join(ROOT, 'caserepo');
const caseInsensitive = fs.existsSync(LOWER);

const graph = {
  nodes: [{ id: 'file:a.ts', title: 'a.ts', kind: 'file', metadata: { source_file: 'a.ts', line: 'L0' } }],
  edges: [],
};
const repoIds = () => db.getDb().prepare('SELECT DISTINCT repo_id FROM code_graph_nodes WHERE user_id=?')
  .all(U).map((r) => r.repo_id).sort();

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('canonicalPathCase returns the on-disk spelling for a case variant, and leaves other paths alone', () => {
  if (caseInsensitive) assert.equal(canonicalPathCase(LOWER), REPO);
  assert.equal(canonicalPathCase(REPO), REPO);
  const missing = path.join(ROOT, 'Nope', 'x');
  assert.equal(canonicalPathCase(missing), missing, 'a path that does not exist is returned resolved, unchanged');
  const link = path.join(ROOT, 'link-to-repo');
  fs.symlinkSync(REPO, link);
  assert.equal(canonicalPathCase(link), link, 'a symlink is NOT resolved — only letter case is canonicalised');
});

test('ingest stores the on-disk spelling and a replace drops the case-variant copy', { skip: !caseInsensitive && 'needs a case-insensitive filesystem' }, () => {
  // The pre-fix state: a copy stored under the lower-case spelling.
  writeCodeGraph(U, LOWER, graph, { source: GRAPH_SOURCE_STRUCTURE });
  assert.deepEqual(repoIds(), [LOWER]);

  const out = ingestStructureGraph(U, LOWER, graph, { replace: true });
  assert.equal(out.repo, REPO, 'the repo_id is the directory\'s real spelling');
  assert.deepEqual(repoIds(), [REPO], 'the stale case-variant copy is gone');
});

test('workspace scoping matches whichever spelling the client sends', { skip: !caseInsensitive && 'needs a case-insensitive filesystem' }, () => {
  assert.deepEqual(workspaceRepoIds(U, LOWER), [REPO]);
  assert.deepEqual(workspaceRepoIds(U, path.join(LOWER, 'src')), [REPO]);
});

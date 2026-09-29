import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-graph-freshness-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { ingestStructureGraph } = await import('../connectors/structure-graph.mjs');
const { handleFindCode } = await import('../llm_agent/runtime/handlers/find-code.mjs');

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-fr-'));
// Registered BEFORE any setup that can throw, so a failed git/DB setup still
// removes the temp repo and DB files.
test.after(() => {
  try { db.closeDb(); } catch { /* setup may have failed before the DB opened */ }
  fs.rmSync(REPO, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});
const U = users.registerUser(db.getDb(), { email: `fr-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'f' }).id;
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(REPO, 'a.ts'), 'export function freshSym() {}\n');
git('add', '.'); git('commit', '-q', '-m', 'one');
const C1 = git('rev-parse', 'HEAD');
db.addUserRepo(U, REPO);
const graph = { nodes: [
  { id: 'file:a.ts', title: 'a.ts', kind: 'file', metadata: { source_file: 'a.ts', line: 'L0' } },
  { id: 'function:a.ts:freshSym', title: 'freshSym', kind: 'function', metadata: { source_file: 'a.ts', line: 'L1' } },
], edges: [] };

test('ingest stores the graph commit on the replacing batch', () => {
  ingestStructureGraph(U, REPO, graph, { replace: true, commitSha: C1, generatedAt: '2026-09-29T00:00:00Z' });
  assert.deepEqual(db.getCodeGraphMeta(U, [REPO]).map((m) => m.commit_sha), [C1]);
});

test('find-code is quiet while the graph matches HEAD', () => {
  const out = handleFindCode({ query: 'freshSym' }, { userId: U, roots: [REPO], workspaceRoot: REPO });
  assert.equal(out.staleGraph, undefined);
});

test('find-code reports staleGraph once HEAD moves', () => {
  fs.writeFileSync(path.join(REPO, 'b.ts'), 'export const x = 1;\n');
  git('add', '.'); git('commit', '-q', '-m', 'two');
  const out = handleFindCode({ query: 'freshSym' }, { userId: U, roots: [REPO], workspaceRoot: REPO, freshnessCacheMs: 0 });
  assert.ok(Array.isArray(out.staleGraph) && out.staleGraph.length === 1);
  assert.equal(out.staleGraph[0].graphCommit, C1.slice(0, 7));
  assert.match(out.hint || '', /graph|stale|line numbers/i);
});

test('find-code treats a stored short SHA that prefixes HEAD as fresh', () => {
  const head = git('rev-parse', 'HEAD');
  ingestStructureGraph(U, REPO, graph, { replace: true, commitSha: head.slice(0, 7), generatedAt: '2026-09-29T00:00:00Z' });
  const out = handleFindCode({ query: 'freshSym' }, { userId: U, roots: [REPO], workspaceRoot: REPO, freshnessCacheMs: 0 });
  assert.equal(out.staleGraph, undefined);
});

// Repo scoping for code-graph reads. Rows carry the INDEXED clone's path as
// repo_id; before this, every read filtered on user_id only, so an llm-ide
// question returned symbols from every repo the user ever graphed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_repo-scope-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { searchCodeIndex } = await import('../graphkit/index.mjs');
const { handleFindCode } = await import('../llm_agent/runtime/handlers/find-code.mjs');

const U = users.registerUser(db.getDb(), {
  email: `rs-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'r',
}).id;

// The live layout: the workspace is a project folder, the graphed repo is a
// child of it. The other repo is unrelated.
const WORKSPACE = fs.mkdtempSync(path.join(__dirname, '_rs-ws-'));
const WS_REPO = path.join(WORKSPACE, 'code', 'app');
const OTHER_REPO = '/Users/someone/affiliate';

const graph = (name) => ({
  nodes: [
    { id: 'file:src/runner.ts', title: 'runner.ts', kind: 'file', metadata: { source_file: 'src/runner.ts', line: 'L0' } },
    { id: `function:src/runner.ts:${name}`, title: name, kind: 'function', metadata: { source_file: 'src/runner.ts', line: 'L3' } },
  ],
  edges: [{ fromId: 'file:src/runner.ts', toId: `function:src/runner.ts:${name}`, kind: 'contains' }],
});

test.before(() => {
  db.writeCodeGraph(U, WS_REPO, graph('runStage'), { source: 'structure' });
  db.writeCodeGraph(U, OTHER_REPO, graph('runStageAffiliate'), { source: 'structure' });
});

test.after(() => {
  db.closeDb();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('workspaceRepoIds matches a repo under the workspace, not an unrelated one', () => {
  assert.deepEqual(db.workspaceRepoIds(U, WORKSPACE), [WS_REPO]);
});

test('workspaceRepoIds matches when the workspace is inside the repo', () => {
  assert.deepEqual(db.workspaceRepoIds(U, path.join(WS_REPO, 'src')), [WS_REPO]);
});

test('workspaceRepoIds returns null when nothing matches (fallback = unscoped)', () => {
  assert.equal(db.workspaceRepoIds(U, '/nowhere/else'), null);
  assert.equal(db.workspaceRepoIds(U, ''), null);
});

test('searchCodeIndex with repoIds returns only that repo', () => {
  const scoped = searchCodeIndex(U, 'runStage', { repoIds: [WS_REPO] });
  assert.deepEqual(scoped.symbols.map((s) => s.title).filter((t) => t.startsWith('runStage')), ['runStage']);
  assert.ok(scoped.symbols.every((s) => s.repo_id === WS_REPO));
});

test('searchCodeIndex without repoIds is unchanged (both repos)', () => {
  const all = searchCodeIndex(U, 'runStage', {});
  const titles = all.symbols.map((s) => s.title);
  assert.ok(titles.includes('runStage') && titles.includes('runStageAffiliate'));
});

test('hydrateSymbols with repoIds drops the other repo\'s row for a shared id', () => {
  const rows = db.hydrateSymbols(U, ['file:src/runner.ts'], { repoIds: [WS_REPO] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repo_id, WS_REPO);
});

test('find-code scopes to the open workspace', () => {
  const out = handleFindCode({ query: 'runStage' }, { userId: U, roots: [WORKSPACE], workspaceRoot: WORKSPACE });
  const names = out.symbols.map((s) => s.name);
  assert.ok(names.includes('runStage'));
  assert.ok(!names.includes('runStageAffiliate'), 'affiliate repo must not leak into this workspace');
});

test('workspaceRepoIds picks only the most specific repo containing the workspace', () => {
  const VENDOR = path.join(WS_REPO, 'vendor', 'lib');
  db.writeCodeGraph(U, VENDOR, graph('vendorFn'), { source: 'structure' });
  assert.deepEqual(db.workspaceRepoIds(U, path.join(VENDOR, 'src')), [VENDOR]);
  assert.deepEqual(db.workspaceRepoIds(U, VENDOR), [VENDOR]);
  assert.deepEqual(db.workspaceRepoIds(U, path.join(WS_REPO, 'src')), [WS_REPO]);
  // Parent workspace still gets every repo beneath it.
  assert.deepEqual([...db.workspaceRepoIds(U, WORKSPACE)].sort(), [WS_REPO, VENDOR].sort());
});

test('resolveRepoScope prefers the active repo over a parent workspace', () => {
  const sib = path.join(WORKSPACE, 'code', 'sibling');
  db.writeCodeGraph(U, sib, graph('siblingOnly'), { source: 'structure' });
  // Parent workspace alone sees both children.
  const both = db.resolveRepoScope(U, { workspaceRoot: WORKSPACE });
  assert.ok(both.includes(WS_REPO) && both.includes(sib));
  // With the active repo, only that one.
  assert.deepEqual(db.resolveRepoScope(U, { activeRepoRoot: WS_REPO, workspaceRoot: WORKSPACE }), [WS_REPO]);
});

test('resolveRepoScope falls back to the workspace when the active repo is not graphed', () => {
  const scoped = db.resolveRepoScope(U, { activeRepoRoot: '/not/graphed/anywhere', workspaceRoot: WORKSPACE });
  assert.ok(scoped.includes(WS_REPO));
});

test('resolveRepoScope: an active repo outside the workspace scope never replaces it', () => {
  // OTHER_REPO is graphed but is not under WORKSPACE (the Settings clone of a
  // different project). It may only narrow the open workspace, not override it.
  const ws = db.resolveRepoScope(U, { workspaceRoot: WORKSPACE });
  const scoped = db.resolveRepoScope(U, { activeRepoRoot: OTHER_REPO, workspaceRoot: WORKSPACE });
  assert.deepEqual([...scoped].sort(), [...ws].sort());
  assert.ok(!scoped.includes(OTHER_REPO));
});

test('resolveRepoScope: no workspace scope means the active repo is not applied', () => {
  assert.equal(db.resolveRepoScope(U, { activeRepoRoot: WS_REPO, workspaceRoot: '/nowhere/else' }), null);
});

// `code-relations` answers the three structural questions find-code only
// approximates in one mixed list: who calls X, what does X call, and what is
// affected if X changes (callers, references, subclasses, and importers of
// X's file — transitively, by hop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-relations-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleCodeRelations } = await import('../llm_agent/runtime/handlers/code-relations.mjs');

const U = users.registerUser(db.getDb(), {
  email: `cr-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c',
}).id;
const WS = fs.mkdtempSync(path.join(__dirname, '_cr-ws-'));
fs.mkdirSync(path.join(WS, 'src'));
for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) fs.writeFileSync(path.join(WS, 'src', f), '// x\n');

const file = (p) => ({ id: `file:${p}`, title: path.basename(p), kind: 'file', metadata: { source_file: p, line: 'L0' } });
const fn = (p, name, line) => ({ id: `function:${p}:${name}`, title: name, kind: 'function', metadata: { source_file: p, line: `L${line}` } });
const contains = (p, name) => ({ fromId: `file:${p}`, toId: `function:${p}:${name}`, kind: 'contains' });
const calls = (fp, from, tp, to) => ({ fromId: `function:${fp}:${from}`, toId: `function:${tp}:${to}`, kind: 'calls' });

test.before(() => {
  db.writeCodeGraph(U, WS, {
    nodes: [
      file('src/a.ts'), file('src/b.ts'), file('src/c.ts'), file('src/d.ts'),
      fn('src/a.ts', 'core', 3), fn('src/b.ts', 'useCore', 5), fn('src/c.ts', 'top', 2),
      fn('src/b.ts', 'helper', 9), fn('src/c.ts', 'main', 1), fn('src/d.ts', 'main', 1),
    ],
    edges: [
      contains('src/a.ts', 'core'), contains('src/b.ts', 'useCore'), contains('src/c.ts', 'top'),
      calls('src/b.ts', 'useCore', 'src/a.ts', 'core'),
      calls('src/c.ts', 'top', 'src/b.ts', 'useCore'),
      calls('src/a.ts', 'core', 'src/b.ts', 'helper'),
      { fromId: 'file:src/d.ts', toId: 'file:src/a.ts', kind: 'imports' },
    ],
  }, { source: 'structure' });
});

test.after(() => {
  db.closeDb();
  fs.rmSync(WS, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

const ctx = () => ({ userId: U, roots: [WS], workspaceRoot: WS });
const names = (out) => out.results.map((r) => `${r.name}@${r.hop}`).sort();

test('callers: direct at depth 1, transitive by hop at depth 2', () => {
  const one = handleCodeRelations({ symbol: 'core', relation: 'callers' }, ctx());
  assert.deepEqual(one.symbol.map((s) => `${s.path}:${s.line}`), ['src/a.ts:3']);
  assert.deepEqual(names(one), ['useCore@1']);
  assert.equal(one.results[0].relation, 'called by');
  const two = handleCodeRelations({ symbol: 'core', relation: 'callers', depth: 2 }, ctx());
  assert.deepEqual(names(two), ['top@2', 'useCore@1']);
});

test('callees: what the symbol calls', () => {
  const out = handleCodeRelations({ symbol: 'core', relation: 'callees' }, ctx());
  assert.deepEqual(names(out), ['helper@1']);
  assert.equal(out.results[0].relation, 'calls');
});

test('impact: callers AND importers of the symbol\'s file, with the affected files listed', () => {
  const out = handleCodeRelations({ symbol: 'core', relation: 'impact', depth: 2 }, ctx());
  const got = out.results.map((r) => `${r.name}:${r.relation}@${r.hop}`).sort();
  assert.ok(got.includes('useCore:called by@1'), got.join(', '));
  assert.ok(got.includes('d.ts:imported by@1'), got.join(', '));
  assert.ok(got.includes('top:called by@2'), got.join(', '));
  assert.deepEqual(out.affectedFiles, ['src/b.ts', 'src/c.ts', 'src/d.ts']);
});

test('a shared name is reported as ambiguous; `path` picks one', () => {
  const both = handleCodeRelations({ symbol: 'main', relation: 'callers' }, ctx());
  assert.equal(both.ambiguous, true);
  assert.deepEqual(both.symbol.map((s) => s.path).sort(), ['src/c.ts', 'src/d.ts']);
  const one = handleCodeRelations({ symbol: 'main', relation: 'callers', path: 'src/d.ts' }, ctx());
  assert.equal(one.ambiguous, undefined);
  assert.deepEqual(one.symbol.map((s) => s.path), ['src/d.ts']);
});

test('an unknown symbol, a bad relation, and no user are plain answers, not throws', () => {
  const none = handleCodeRelations({ symbol: 'nope', relation: 'callers' }, ctx());
  assert.deepEqual(none.symbol, []);
  assert.match(none.hint, /find-code/);
  assert.match(handleCodeRelations({ symbol: 'core', relation: 'sideways' }, ctx()).error, /relation/);
  assert.match(handleCodeRelations({ symbol: 'core', relation: 'callers' }, {}).error, /signed in/);
});

// The real multi-repo layout: a project root that is NOT itself graphed,
// with its repos under code/<repo> (what bf48a688 now graphs in full).
const PROJ = fs.mkdtempSync(path.join(__dirname, '_cr-proj-'));
const REPO_A = path.join(PROJ, 'code', 'api');
const REPO_B = path.join(PROJ, 'code', 'web');
const pctx = () => ({ userId: U, roots: [PROJ], workspaceRoot: PROJ });
test.after(() => fs.rmSync(PROJ, { recursive: true, force: true }));

// Structure-graph ids carry no repo (`file:src/index.ts`), so two repos with
// the same relative path shared ids — and a traversal scoped to both returned
// the OTHER repo's callers as this one's. Each seed now walks its own repo.
test('two repos with the same relative path do not leak into each other', () => {
  db.writeCodeGraph(U, REPO_A, {
    nodes: [file('src/a.ts'), fn('src/a.ts', 'core', 3), fn('src/b.ts', 'apiCaller', 5)],
    edges: [calls('src/b.ts', 'apiCaller', 'src/a.ts', 'core')],
  }, { source: 'structure' });
  db.writeCodeGraph(U, REPO_B, {
    nodes: [file('src/a.ts'), fn('src/a.ts', 'core', 3), fn('src/z.ts', 'webCaller', 1)],
    edges: [calls('src/z.ts', 'webCaller', 'src/a.ts', 'core')],
  }, { source: 'structure' });
  const out = handleCodeRelations({ symbol: 'core', relation: 'callers' }, pctx());
  assert.equal(out.ambiguous, true);
  assert.deepEqual(out.symbol.map((s) => s.repo).sort(), ['api', 'web']);
  const got = out.results.map((r) => `${r.name}@${r.repo}`).sort();
  assert.deepEqual(got, ['apiCaller@api', 'webCaller@web'], 'each caller is attributed to its own repo');
  const onlyApi = handleCodeRelations({ symbol: 'core', relation: 'callers', path: 'code/api/src/a.ts' }, pctx());
  assert.deepEqual(onlyApi.results.map((r) => r.name), ['apiCaller'], 'a workspace-relative path picks one repo');
});

test('callers also follows references — the only usage edges a SCIP graph has', () => {
  const SCIP = path.join(PROJ, 'code', 'scip');
  db.writeCodeGraph(U, SCIP, {
    nodes: [{ id: 'scip:lib/x#Thing', title: 'ScipThing', kind: 'class', metadata: { source_file: 'lib/x.ts', line: 'L4' } },
      { id: 'scip:lib/y#user', title: 'scipUser', kind: 'function', metadata: { source_file: 'lib/y.ts', line: 'L2' } }],
    edges: [{ fromId: 'scip:lib/y#user', toId: 'scip:lib/x#Thing', kind: 'references' }],
  }, { source: 'scip' });
  const out = handleCodeRelations({ symbol: 'ScipThing', relation: 'callers' }, pctx());
  assert.deepEqual(out.results.map((r) => `${r.name}:${r.relation}`), ['scipUser:referenced by']);
});

test('path: ./-prefixed, repo-relative or absolute picks the symbol, past the first 20 namesakes', () => {
  const MANY = path.join(PROJ, 'code', 'many');
  const nodes = [];
  for (let i = 0; i < 30; i += 1) nodes.push(fn(`pkg/m${String(i).padStart(2, '0')}.ts`, 'render', i + 1));
  db.writeCodeGraph(U, MANY, { nodes, edges: [] }, { source: 'structure' });
  for (const p of ['./pkg/m29.ts', 'pkg/m29.ts', path.join(MANY, 'pkg/m29.ts')]) {
    const out = handleCodeRelations({ symbol: 'render', relation: 'callers', path: p }, pctx());
    assert.deepEqual(out.symbol.map((s) => s.line), [30], `found via ${p}`);
    assert.equal(out.ambiguous, undefined, p);
  }
});

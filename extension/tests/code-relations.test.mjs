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

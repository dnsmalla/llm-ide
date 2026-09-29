// check-citations: the in-turn output check for plans. It must flag cited
// files that do not exist, `path:line` past the end of the file, and symbols
// the repo-scoped graph does not know — and never return file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_check-citations-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleCheckCitations, extractCitations } = await import('../llm_agent/runtime/handlers/check-citations.mjs');

const U = users.registerUser(db.getDb(), {
  email: `cc-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c',
}).id;
const WS = fs.mkdtempSync(path.join(__dirname, '_cc-ws-'));
fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
fs.writeFileSync(path.join(WS, 'src', 'pin.ts'), 'export function rotatePin() {}\n// two\n// three\n');
db.writeCodeGraph(U, WS, {
  nodes: [
    { id: 'file:src/pin.ts', title: 'pin.ts', kind: 'file', metadata: { source_file: 'src/pin.ts', line: 'L0' } },
    { id: 'function:src/pin.ts:rotatePin', title: 'rotatePin', kind: 'function', metadata: { source_file: 'src/pin.ts', line: 'L1' } },
  ],
  edges: [],
}, { source: 'structure' });
const ctx = { userId: U, roots: [WS], workspaceRoot: WS };

test.after(() => {
  db.closeDb();
  fs.rmSync(WS, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('extractCitations finds backticked paths with lines and code symbols', () => {
  const c = extractCitations('Edit `src/pin.ts:2`, `src/a/b.swift` and `README.md`, then call `rotatePin()` and `Store.save`. Not `the plan`.');
  assert.deepEqual(c.paths, [
    { path: 'src/pin.ts', line: 2, endLine: null },
    { path: 'src/a/b.swift', line: null, endLine: null },
    { path: 'README.md', line: null, endLine: null },
  ]);
  // `Store.save` (dotted, no call) is a property-ish name: no longer judged (H4).
  assert.deepEqual(c.symbols.sort(), ['rotatePin']);
});

test('a clean plan is ok', () => {
  const out = handleCheckCitations({ text: 'Change `src/pin.ts:1` in `rotatePin()`.' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.graphChecked, true);
  assert.deepEqual([out.missingPaths, out.lineOutOfRange, out.unknownSymbols], [[], [], []]);
});

test('missing file, out-of-range line and unknown symbol are all reported', () => {
  const out = handleCheckCitations({ text: 'See `src/gone.ts`, `src/pin.ts:99` and `inventedHelper()`.' }, ctx);
  assert.equal(out.ok, false);
  assert.deepEqual(out.missingPaths, ['src/gone.ts']);
  assert.deepEqual(out.lineOutOfRange, [{ path: 'src/pin.ts', line: 99, lines: 3 }]);
  assert.deepEqual(out.unknownSymbols, ['inventedHelper']);
});

test('never returns file contents', () => {
  const out = handleCheckCitations({ text: '`src/pin.ts:1`' }, ctx);
  assert.ok(!JSON.stringify(out).includes('export function'));
});

test('without a scoped graph, symbols are not judged', () => {
  const out = handleCheckCitations({ text: '`inventedHelper()`' }, { userId: U, roots: [], workspaceRoot: '/nowhere' });
  assert.equal(out.graphChecked, false);
  assert.deepEqual(out.unknownSymbols, []);
});

test('rejects empty text', () => {
  assert.ok(handleCheckCitations({ text: '' }, ctx).error);
});

test('new-file-safe: bare names, builtins, columns and env vars are not flagged', () => {
  const out = handleCheckCitations({
    text: 'Edit `src/pin.ts:1`, bare `pin.ts`, use `JSON.parse`, `user_id`, `LLMIDE_KEYCHAIN_BACKEND` and `rotatePin()`.',
  }, ctx);
  assert.equal(out.ok, true);
  assert.deepEqual([out.missingPaths, out.unknownSymbols], [[], []]);
});

test('a real invented name is still reported next to builtins', () => {
  const out = handleCheckCitations({ text: '`JSON.parse` then `inventedHelper()`' }, ctx);
  assert.deepEqual(out.unknownSymbols, ['inventedHelper']);
});

test('line counting never reads an unvalidated workspaceRoot', () => {
  const rogue = fs.mkdtempSync(path.join(__dirname, '_cc-rogue-'));
  try {
    fs.mkdirSync(path.join(rogue, 'src'), { recursive: true });
    const hundred = Array.from({ length: 100 }, (_, i) => `// ${i}`).join('\n') + '\n';
    fs.writeFileSync(path.join(rogue, 'src', 'pin.ts'), hundred);   // also exists in roots (3 lines)
    fs.writeFileSync(path.join(rogue, 'src', 'only-rogue.ts'), hundred);
    const out = handleCheckCitations(
      { text: '`src/pin.ts:50` and `src/only-rogue.ts:50`' },
      { userId: U, roots: [WS], workspaceRoot: rogue },
    );
    assert.deepEqual(out.lineOutOfRange, [{ path: 'src/pin.ts', line: 50, lines: 3 }]);
    assert.deepEqual(out.missingPaths, ['src/only-rogue.ts']);
  } finally {
    fs.rmSync(rogue, { recursive: true, force: true });
  }
});

test('only call-form names and PascalCase types are judged (H4)', () => {
  const c = extractCitations('`activeProject`, `seedLimit`, `Store.save`, `a.b.c`, `rotatePin()`, `Store.save()`, `InventedType`, `Map`, `HTTP`, `JSON.parse()`');
  assert.deepEqual(c.symbols.sort(), ['InventedType', 'rotatePin', 'save'].sort());
  const out = handleCheckCitations({ text: '`activeProject` `seedLimit` `Store.save` then `rotatePin()`, `inventedHelper()`, `InventedType`.' }, ctx);
  assert.deepEqual(out.unknownSymbols.sort(), ['InventedType', 'inventedHelper'].sort());
});

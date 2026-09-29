// Golden queries for find-code: the right symbol must rank in the top 3, the
// open workspace's repo must not be polluted by another repo, and the payload
// the model receives must stay within budget. Fixture mirrors the live shapes
// (repo-relative ids, INDEXED clone path under the project folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_retrieval-golden-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleFindCode } = await import('../llm_agent/runtime/handlers/find-code.mjs');
const U = users.registerUser(db.getDb(), {
  email: `rg-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'g',
}).id;

const WORKSPACE = fs.mkdtempSync(path.join(__dirname, '_rg-ws-'));
const REPO = path.join(WORKSPACE, 'code', 'llm-ide');
const OTHER = '/Users/someone/affiliate';

// ~1k tokens: a find-code answer must stay well under a whole-file read.
const PAYLOAD_BUDGET_CHARS = 4000;

const sym = (file, name, kind, line) => ({
  id: `${kind}:${file}:${name}`, title: name, kind,
  metadata: { source_file: file, line: `L${line}` },
});
const file = (f) => ({ id: `file:${f}`, title: path.basename(f), kind: 'file', metadata: { source_file: f, line: 'L0' } });

// expectAny: any of these in the top 3 passes. The natural-language query can
// only reach `MobilePin` today — seeding is a token LIKE, and "rotated" does
// not match `rotateInMemory`. That gap is the Phase C/D baseline; widen this
// entry to require `rotateInMemory` alone once seeding handles stems.
const GOLDEN = [
  { query: 'rotateInMemory', expectAny: ['rotateInMemory'] },
  { query: 'where is the mobile PIN rotated', expectAny: ['rotateInMemory', 'MobilePin'] },
  { query: 'LoopEngineRunner retry stage', expectAny: ['LoopEngineRunner'] },
  { query: 'findGraphContext', expectAny: ['findGraphContext'] },
];

test.before(() => {
  const files = ['mac/MobilePin.swift', 'mac/LoopEngineRunner.swift', 'extension/graphkit/graph.mjs'];
  db.writeCodeGraph(U, REPO, {
    nodes: [
      ...files.map(file),
      sym('mac/MobilePin.swift', 'MobilePin', 'classType', 10),
      sym('mac/MobilePin.swift', 'rotateInMemory', 'function', 42),
      sym('mac/LoopEngineRunner.swift', 'LoopEngineRunner', 'classType', 20),
      sym('mac/LoopEngineRunner.swift', 'retryStage', 'function', 300),
      sym('extension/graphkit/graph.mjs', 'findGraphContext', 'function', 79),
    ],
    edges: [
      { fromId: 'file:mac/MobilePin.swift', toId: 'function:mac/MobilePin.swift:rotateInMemory', kind: 'contains' },
      { fromId: 'file:mac/LoopEngineRunner.swift', toId: 'classType:mac/LoopEngineRunner.swift:LoopEngineRunner', kind: 'contains' },
    ],
  }, { source: 'structure' });
  // The affiliate repo shares generic names — the live pollution case.
  db.writeCodeGraph(U, OTHER, {
    nodes: [file('src/jobs/runner.ts'), sym('src/jobs/runner.ts', 'retryStage', 'function', 5),
      sym('src/jobs/runner.ts', 'LoopRunner', 'classType', 1)],
    edges: [],
  }, { source: 'structure' });
});

test.after(() => {
  db.closeDb();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

for (const g of GOLDEN) {
  test(`golden: "${g.query}"`, () => {
    const out = handleFindCode({ query: g.query }, { userId: U, roots: [WORKSPACE], workspaceRoot: WORKSPACE });
    const top3 = out.symbols.slice(0, 3).map((s) => s.name);
    assert.ok(g.expectAny.some((n) => top3.includes(n)),
      `expected one of ${JSON.stringify(g.expectAny)} in top 3, got ${JSON.stringify(top3)}`);
    const all = [...out.symbols, ...out.related].map((s) => s.path);
    assert.ok(!all.some((p) => p.startsWith('src/jobs/')), 'affiliate repo leaked into this workspace');
    const size = JSON.stringify(out).length;
    assert.ok(size <= PAYLOAD_BUDGET_CHARS, `payload ${size} chars > budget ${PAYLOAD_BUDGET_CHARS}`);
  });
}

// Parent workspace with two sibling graphed repos: a sibling's symbol must not leak.
// The client's active repo (activeRepoRoot) selects the one the user works in.
test('parent workspace with sibling repos does not leak a sibling repo', () => {
  const PARENT = fs.mkdtempSync(path.join(__dirname, '_rg-parent-'));
  try {
    const A = path.join(PARENT, 'code', 'alpha');
    const B = path.join(PARENT, 'code', 'beta');
    db.writeCodeGraph(U, A, { nodes: [file('a.ts'), sym('a.ts', 'siblingAlphaOnly', 'function', 1)], edges: [] }, { source: 'structure' });
    db.writeCodeGraph(U, B, { nodes: [file('b.ts'), sym('b.ts', 'siblingBetaOnly', 'function', 1)], edges: [] }, { source: 'structure' });
    const out = handleFindCode({ query: 'siblingBetaOnly' }, { userId: U, roots: [A], workspaceRoot: PARENT, activeRepoRoot: A });
    const names = [...out.symbols, ...out.related].map((s) => s.name ?? s.path);
    assert.ok(!names.includes('siblingBetaOnly'), `sibling repo leaked: ${JSON.stringify(names)}`);
  } finally {
    fs.rmSync(PARENT, { recursive: true, force: true });
  }
});

test('parent workspace without an active repo searches every child repo (documented fallback)', () => {
  const PARENT = fs.mkdtempSync(path.join(__dirname, '_rg-parent-'));
  try {
    const A = path.join(PARENT, 'code', 'alpha');
    const B = path.join(PARENT, 'code', 'beta');
    db.writeCodeGraph(U, A, { nodes: [file('a.ts'), sym('a.ts', 'siblingAlphaOnly', 'function', 1)], edges: [] }, { source: 'structure' });
    db.writeCodeGraph(U, B, { nodes: [file('b.ts'), sym('b.ts', 'siblingBetaOnly', 'function', 1)], edges: [] }, { source: 'structure' });
    const ctx = { userId: U, roots: [A], workspaceRoot: PARENT };
    const names = (q) => {
      const out = handleFindCode({ query: q }, ctx);
      return [...out.symbols, ...out.related].map((s) => s.name ?? s.path);
    };
    assert.ok(names('siblingBetaOnly').includes('siblingBetaOnly'));
    assert.ok(names('siblingAlphaOnly').includes('siblingAlphaOnly'));
  } finally {
    fs.rmSync(PARENT, { recursive: true, force: true });
  }
});

// Doc-only seeds must not crowd out a later token's exact title match (fails today: top 3 are doc-only handlers).
test('doc-only seeds do not crowd out an exact title match', () => {
  const R = path.join(WORKSPACE, 'code', 'crowd');
  const LONG = 'authenticationmiddlewareconfiguration';
  const nodes = [file('c/f.ts')];
  for (let i = 0; i < 60; i++) {
    nodes.push({ id: `function:c/f.ts:handler${i}`, title: `handler${i}`, kind: 'function',
      metadata: { source_file: 'c/f.ts', line: `L${i + 1}`, doc: `${LONG} helper number ${i}` } });
  }
  nodes.push(sym('c/f.ts', 'zebraTarget', 'function', 999));
  db.writeCodeGraph(U, R, { nodes, edges: [] }, { source: 'structure' });
  const out = handleFindCode({ query: `${LONG} zebraTarget` }, { userId: U, roots: [WORKSPACE], workspaceRoot: R });
  const top3 = out.symbols.slice(0, 3).map((s) => s.name);
  assert.ok(top3.includes('zebraTarget'), `zebraTarget not in top 3: ${JSON.stringify(top3)}`);
});

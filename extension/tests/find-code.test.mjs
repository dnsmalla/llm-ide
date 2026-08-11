// find-code: the agent's index→graph code search.
//
// Covers the three layers separately, because each one failed differently
// before this feature existed:
//   kb/code-graph.mjs      — traversal was OUT-ONLY, so "who calls this" was
//                            unanswerable; seeding had no ORDER BY, so which
//                            rows came back was whatever SQLite scanned first.
//   graphkit/graph.mjs     — no staged search existed at all.
//   handlers/find-code.mjs — the agent-facing contract: paths it returns must
//                            be openable by read-file (graph rows carry the
//                            INDEXED clone's repo_id, which is routinely not
//                            the open workspace), and nothing outside the
//                            readable roots may be advertised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_find-code-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { searchCodeIndex, relationLabel, seedCandidates } = await import('../graphkit/index.mjs');
const { handleFindCode, resolveAgentPath, orderRoots } = await import('../llm_agent/runtime/handlers/find-code.mjs');

const U = users.registerUser(db.getDb(), {
  email: `fc-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'f',
}).id;

// A workspace on disk, so path resolution is exercised for real. INDEXED_REPO is
// deliberately a DIFFERENT directory from WORKSPACE — that mismatch (a second
// clone / a moved repo) is the live condition in this install and used to make
// every graph path unreadable.
const WORKSPACE = fs.mkdtempSync(path.join(__dirname, '_fc-ws-'));
const INDEXED_REPO = '/Users/someone/elsewhere/llm-ide';
fs.mkdirSync(path.join(WORKSPACE, 'src'), { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, 'src', 'gutter.ts'), 'export function renderGutter() {}\n');
fs.writeFileSync(path.join(WORKSPACE, 'src', 'view.ts'), 'import { renderGutter } from "./gutter";\n');

test.after(() => {
  try { fs.rmSync(WORKSPACE, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

test('setup: a file→symbol→symbol graph like the Mac app produces', () => {
  db.writeCodeGraph(U, INDEXED_REPO, {
    nodes: [
      { id: 'file:src/gutter.ts', title: 'gutter.ts', kind: 'file', metadata: { source_file: 'src/gutter.ts', line: 'L0', language: 'typescript' } },
      { id: 'file:src/view.ts', title: 'view.ts', kind: 'file', metadata: { source_file: 'src/view.ts', line: 'L0', language: 'typescript' } },
      { id: 'function:src/gutter.ts:renderGutter', title: 'renderGutter', kind: 'function', metadata: { source_file: 'src/gutter.ts', line: 'L1' } },
      { id: 'function:src/gutter.ts:renderGutterInner', title: 'renderGutterInner', kind: 'function', metadata: { source_file: 'src/gutter.ts', line: 'L9' } },
      { id: 'function:src/view.ts:drawView', title: 'drawView', kind: 'function', metadata: { source_file: 'src/view.ts', line: 'L4' } },
    ],
    edges: [
      { fromId: 'file:src/gutter.ts', toId: 'function:src/gutter.ts:renderGutter', kind: 'contains' },
      { fromId: 'file:src/gutter.ts', toId: 'function:src/gutter.ts:renderGutterInner', kind: 'contains' },
      { fromId: 'file:src/view.ts', toId: 'function:src/view.ts:drawView', kind: 'contains' },
      { fromId: 'file:src/view.ts', toId: 'file:src/gutter.ts', kind: 'imports' },
      // drawView → renderGutter: the caller relationship the agent needs.
      { fromId: 'function:src/view.ts:drawView', toId: 'function:src/gutter.ts:renderGutter', kind: 'calls' },
    ],
  }, { source: 'structure' });
});

// ── kb/code-graph.mjs ──────────────────────────────────────────────────────

test('graphNeighbors walks INWARD — "who calls this" is answerable', () => {
  const hits = db.graphNeighbors(U, ['function:src/gutter.ts:renderGutter'], { hops: 1 });
  const callers = hits.filter((h) => h.viaKind === 'calls' && h.direction === 'in');
  assert.deepEqual(callers.map((h) => h.symbolId), ['function:src/view.ts:drawView'],
    'the caller must come back; expandSymbols (out-only) can never find it');
});

test('graphNeighbors labels direction so relatedness is explainable', () => {
  const out = db.graphNeighbors(U, ['function:src/view.ts:drawView'], { hops: 1, direction: 'out' });
  const call = out.find((h) => h.viaKind === 'calls');
  assert.equal(call.direction, 'out');
  assert.equal(relationLabel('calls', 'out'), 'calls');
  assert.equal(relationLabel('calls', 'in'), 'called by');
});

test('graphNeighbors direction:in excludes outward edges', () => {
  const hits = db.graphNeighbors(U, ['function:src/view.ts:drawView'], { hops: 1, direction: 'in' });
  assert.equal(hits.some((h) => h.symbolId === 'function:src/gutter.ts:renderGutter'), false);
});

test('graphNeighbors respects its limit and excludes the seeds', () => {
  const hits = db.graphNeighbors(U, ['file:src/gutter.ts'], {
    hops: 2, limit: 1, edgeKinds: ['contains', 'imports'],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits.some((h) => h.symbolId === 'file:src/gutter.ts'), false, 'seed must not be returned');
});

test('searchCodeSymbols ranks exact title over longer substring matches', () => {
  const rows = db.searchCodeSymbols(U, 'renderGutter', 10);
  assert.equal(rows[0].title, 'renderGutter',
    'exact match must outrank renderGutterInner — findCodeSymbolIds had no ORDER BY at all');
  assert.ok(rows.some((r) => r.title === 'renderGutterInner'), 'substring match still included');
});

test('searchCodeSymbols escapes LIKE wildcards', () => {
  assert.deepEqual(db.searchCodeSymbols(U, '%', 10), [], 'a bare % must not match everything');
  assert.deepEqual(db.searchCodeSymbols(U, '_enderGutter', 10), [], '_ must be literal, not any-char');
});

// ── graphkit/graph.mjs ────────────────────────────────────────────────────

test('searchCodeIndex returns the definition site plus labelled neighbours', () => {
  const res = searchCodeIndex(U, 'renderGutter', { limit: 8, hops: 1 });
  assert.equal(res.symbols[0].title, 'renderGutter');
  assert.equal(res.symbols[0].line, 1, 'file:line is the whole point');
  const caller = res.related.find((r) => r.title === 'drawView');
  assert.ok(caller, 'the caller must appear in related');
  assert.equal(caller.relation, 'called by');
  assert.equal(res.indexPresent, true);
});

test('searchCodeIndex seeds from a TOKEN of a free-text question', () => {
  // "why are the line numbers wrong in renderGutter" — no whole-string LIKE
  // could match, so token seeding is what makes natural questions work.
  const res = searchCodeIndex(U, 'why are line numbers wrong in renderGutter', { limit: 5 });
  assert.ok(res.symbols.some((s) => s.title === 'renderGutter'));
});

test('searchCodeIndex re-ranks across probes, not by which token was probed first', () => {
  // Two words: "gutter" (a clean prefix match on gutter.ts) and "renderer" —
  // whose longer length means it is probed FIRST. An incidental substring hit
  // from the earlier probe must not outrank the prefix match from the later one.
  const X = users.registerUser(db.getDb(), {
    email: `fc-rank-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'r',
  }).id;
  db.writeCodeGraph(X, '/repo', {
    nodes: [
      { id: 'sym:a', title: 'legacyRendererShimForTests', kind: 'function', metadata: { source_file: 'a.ts', line: 'L1' } },
      { id: 'sym:b', title: 'gutter', kind: 'function', metadata: { source_file: 'b.ts', line: 'L2' } },
    ],
    edges: [],
  }, { source: 'structure' });
  const res = searchCodeIndex(X, 'renderer gutter', { limit: 5, hops: 0 });
  assert.equal(res.symbols[0].title, 'gutter',
    'exact-tier match must lead regardless of probe order');
});

test('searchCodeIndex expands a FILE seed through contains — a symbol outline', () => {
  const res = searchCodeIndex(U, 'gutter.ts', { limit: 8, hops: 1 });
  const names = res.related.map((r) => r.title);
  assert.ok(names.includes('renderGutter') && names.includes('renderGutterInner'),
    'a file seed must list what it declares (contains is excluded from the symbol-seed edge set)');
  assert.ok(res.related.find((r) => r.title === 'renderGutter').relation === 'declares');
});

test('searchCodeIndex falls back to file-level relatedness when a symbol has no symbol edges', () => {
  // renderGutterInner has no calls/references edges — the live condition for
  // every Swift/JS/TS symbol until graph-kit's regex extractor emits call
  // edges. The file→file `imports` edges must still yield the blast radius.
  const res = searchCodeIndex(U, 'renderGutterInner', { limit: 8, hops: 1 });
  assert.equal(res.symbols[0].title, 'renderGutterInner');
  const byRelation = Object.fromEntries(res.related.map((r) => [r.relation, r.title]));
  assert.equal(byRelation['declared in'], 'gutter.ts');
  assert.equal(byRelation['file imported by'], 'view.ts',
    'the importing file is the honest file-granularity answer to "what does this affect"');
});

test('the file-level fallback does NOT dilute a symbol that has real edges', () => {
  const res = searchCodeIndex(U, 'renderGutter', { limit: 8, hops: 1 });
  assert.ok(res.related.some((r) => r.relation === 'called by'), 'real call edge present');
  assert.equal(res.related.some((r) => r.relation === 'file imported by'), false,
    'fallback must stay off when the symbol-level pass produced results');
});

test('indexPresent reports whether a graph EXISTS, not whether this query matched', () => {
  // The distinction the agent acts on: a miss against a real index means
  // "refine the query", a missing index means "go generate one". Deriving it
  // from the result set told every user with a good index they had none.
  const miss = searchCodeIndex(U, 'zzz-nonexistent-symbol', { limit: 5 });
  assert.deepEqual(miss.symbols, []);
  assert.equal(miss.indexPresent, true, 'this user HAS a graph — a miss must not claim otherwise');

  const other = users.registerUser(db.getDb(), {
    email: `fc-noindex-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'n',
  }).id;
  assert.equal(searchCodeIndex(other, 'renderGutter', { limit: 5 }).indexPresent, false,
    'a user with no graph rows at all');
});

test('seedCandidates is capped, so a long question cannot fire ~30 table scans', () => {
  const words = Array.from({ length: 40 }, (_, i) => `token${i}longenough`).join(' ');
  assert.ok(seedCandidates(words).length <= 6,
    'each candidate is an unindexable leading-% LIKE run synchronously on the server thread');
  // Whole query first, then longest tokens — the truncated tail is the least
  // selective part.
  assert.equal(seedCandidates('fix the renderGutter offset')[0], 'fix the renderGutter offset');
  assert.ok(seedCandidates('fix the renderGutter offset').includes('renderGutter'));
});

test('searchCodeIndex does not let dangling edges consume the related budget', () => {
  // A node with a blank source_file and edges pointing at ids that have no node
  // row: both used to count against the cap BEFORE hydration, which could empty
  // the section while real neighbours existed one row down.
  const V = users.registerUser(db.getDb(), {
    email: `fc-dangle-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'd',
  }).id;
  db.writeCodeGraph(V, '/repo', {
    nodes: [
      { id: 'sym:hub', title: 'hubThing', kind: 'function', metadata: { source_file: 'hub.ts', line: 'L1' } },
      { id: 'sym:blank', title: 'blankFile', kind: 'function', metadata: { source_file: '', line: 'L2' } },
      { id: 'sym:real', title: 'realNeighbor', kind: 'function', metadata: { source_file: 'real.ts', line: 'L7' } },
    ],
    edges: [
      { fromId: 'sym:hub', toId: 'sym:ghost1', kind: 'calls' },   // no node row
      { fromId: 'sym:hub', toId: 'sym:ghost2', kind: 'calls' },   // no node row
      { fromId: 'sym:hub', toId: 'sym:blank', kind: 'calls' },    // node, no path
      { fromId: 'sym:hub', toId: 'sym:real', kind: 'calls' },
    ],
  }, { source: 'structure' });
  const res = searchCodeIndex(V, 'hubThing', { limit: 1, hops: 1 });
  assert.deepEqual(res.related.map((r) => r.title), ['realNeighbor'],
    'the only usable neighbour must survive; unusable edges must not spend the budget');
});

test('searchCodeIndex is safe on an empty query', () => {
  const res = searchCodeIndex(U, '   ', {});
  assert.deepEqual([res.symbols, res.related, res.files], [[], [], []]);
});

// ── handlers/find-code.mjs ────────────────────────────────────────────────

test('resolveAgentPath prefers the repo-relative form that exists in the workspace', () => {
  const r = resolveAgentPath('src/gutter.ts', [WORKSPACE]);
  assert.deepEqual(r, { path: 'src/gutter.ts', exists: true });
});

test('resolveAgentPath strips an absolute FTS ref back to repo-relative', () => {
  const abs = path.join(WORKSPACE, 'src', 'view.ts');
  assert.deepEqual(resolveAgentPath(abs, [WORKSPACE]), { path: 'src/view.ts', exists: true });
});

test('resolveAgentPath refuses paths outside the readable roots and traversals', () => {
  assert.equal(resolveAgentPath('/etc/passwd', [WORKSPACE]), null);
  assert.equal(resolveAgentPath('../../secrets.txt', [WORKSPACE]), null);
  assert.equal(resolveAgentPath('', [WORKSPACE]), null);
});

test('handleFindCode returns read-file-openable paths despite a foreign repo_id', () => {
  const out = handleFindCode({ query: 'renderGutter' }, { userId: U, roots: [WORKSPACE] });
  assert.equal(out.error, undefined);
  const def = out.symbols[0];
  assert.deepEqual(
    { name: def.name, path: def.path, line: def.line },
    { name: 'renderGutter', path: 'src/gutter.ts', line: 1 },
  );
  assert.equal(def.unverifiedPath, undefined,
    'the file IS in the workspace, so it must not be flagged unverified even though repo_id points elsewhere');
  assert.ok(out.related.some((r) => r.name === 'drawView' && r.relation === 'called by'));
  assert.match(out.hint, /read only the ranges you need/i);
});

test('handleFindCode flags a path the index knows but disk does not', () => {
  db.writeCodeGraph(U, INDEXED_REPO, {
    nodes: [{
      id: 'function:src/deleted.ts:ghostFn',
      title: 'ghostFn',
      kind: 'function',
      metadata: { source_file: 'src/deleted.ts', line: 'L3' },
    }],
    edges: [],
  }, { source: 'structure' });
  const out = handleFindCode({ query: 'ghostFn' }, { userId: U, roots: [WORKSPACE] });
  assert.equal(out.symbols[0].unverifiedPath, true, 'a stale index entry must be marked, not silently quoted');
});

test('handleFindCode validates its arguments', () => {
  assert.match(handleFindCode({ query: '  ' }, { userId: U, roots: [] }).error, /query is required/);
  assert.match(handleFindCode({ query: 'x' }, { roots: [] }).error, /not signed in/);
});

test('handleFindCode clamps limit and hops instead of trusting the model', () => {
  const out = handleFindCode(
    { query: 'render', limit: 9999, hops: 99 },
    { userId: U, roots: [WORKSPACE] },
  );
  assert.ok(out.symbols.length <= 20, 'limit clamped to MAX_LIMIT');
  // hops clamped to 2: with a 2-hop walk from renderGutter we reach drawView
  // (in via calls) and then view.ts (in via contains) — but never more than the
  // related cap allows.
  assert.ok(out.related.length <= 24, 'related section stays bounded');
  const junk = handleFindCode({ query: 'render', hops: 'abc' }, { userId: U, roots: [WORKSPACE] });
  assert.equal(junk.error, undefined, 'a non-numeric hops falls back to the default, not a crash');
});

test('handleFindCode tells the agent when the project has no index at all', () => {
  const other = users.registerUser(db.getDb(), {
    email: `fc2-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'g',
  }).id;
  const out = handleFindCode({ query: 'renderGutter' }, { userId: other, roots: [WORKSPACE] });
  assert.deepEqual(out.symbols, [], 'tenancy: another user sees none of this graph');
  assert.match(out.hint, /no code index yet/i);
});

test('handleFindCode distinguishes a query miss from a missing index', () => {
  const out = handleFindCode({ query: 'zzz-nonexistent-symbol' }, { userId: U, roots: [WORKSPACE] });
  assert.deepEqual(out.symbols, []);
  assert.match(out.hint, /no match in the index/i);
  assert.doesNotMatch(out.hint, /no code index yet/i,
    'this user HAS an index — telling them to go generate one is a wrong instruction');
});

test('with no readable roots a relative hit is still reported, but flagged unverified', () => {
  // A relative path is not gated on the roots (read-file resolves it against
  // each one), so the location is still worth telling the agent — it just can't
  // be confirmed against disk.
  const out = handleFindCode({ query: 'renderGutter' }, { userId: U, roots: [] });
  assert.equal(out.symbols[0].path, 'src/gutter.ts');
  assert.equal(out.symbols[0].unverifiedPath, true);
});

test('an ABSOLUTE indexed path outside every readable root is dropped, and the hint says why', () => {
  // Security: an absolute path is only emitted when it falls inside a readable
  // root, so a malicious/buggy ingest cannot hand the agent /etc/passwd. When
  // that leaves nothing to report, the hint must not blame the query or claim
  // the index is missing.
  const W = users.registerUser(db.getDb(), {
    email: `fc-abs-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'a',
  }).id;
  db.writeCodeGraph(W, '/repo', {
    nodes: [{
      id: 'sym:leak', title: 'leakyThing', kind: 'function',
      metadata: { source_file: '/etc/passwd', line: 'L1' },
    }],
    edges: [],
  }, { source: 'structure' });
  const out = handleFindCode({ query: 'leakyThing' }, { userId: W, roots: [WORKSPACE], workspaceRoot: WORKSPACE });
  assert.deepEqual(out.symbols, [], 'an out-of-root absolute path must never reach the agent');
  assert.match(out.hint, /outside the readable workspace/i,
    'not a bad query and not a missing index — the files just are not readable');
});

// ── root ordering: the open workspace wins ────────────────────────────────

test('orderRoots puts the open workspace first', () => {
  const stale = fs.mkdtempSync(path.join(__dirname, '_fc-stale-'));
  try {
    assert.deepEqual(orderRoots([stale, WORKSPACE], WORKSPACE), [WORKSPACE, stale]);
    // A workspace that is not already a readable root must not widen the set.
    assert.deepEqual(orderRoots([stale], '/some/other/place'), [stale]);
    assert.deepEqual(orderRoots([stale, WORKSPACE], ''), [stale, WORKSPACE]);
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
  }
});

test('a relpath present in two roots resolves to the WORKSPACE, not a stale clone', () => {
  // The live condition: the graph is indexed from one checkout while the user
  // works in another. Resolving to the allow-listed clone returned exists:true
  // for the wrong file, and run-bash (cwd = workspace) would then read a
  // different one than the agent quoted.
  const stale = fs.mkdtempSync(path.join(__dirname, '_fc-stale2-'));
  try {
    fs.mkdirSync(path.join(stale, 'src'), { recursive: true });
    fs.writeFileSync(path.join(stale, 'src', 'gutter.ts'), '// stale copy\n');
    const roots = [stale, WORKSPACE];               // buildReadableRoots' order
    const r = resolveAgentPath('src/gutter.ts', roots, WORKSPACE);
    assert.equal(r.path, 'src/gutter.ts');
    assert.equal(r.exists, true);
    assert.equal(r.outsideWorkspace, undefined, 'resolved in the workspace, so no flag');

    // With no workspace declared, the first root still wins — but nothing is
    // claimed about which tree it came from.
    assert.equal(resolveAgentPath('src/gutter.ts', roots).outsideWorkspace, undefined);
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
  }
});

test('a hit that only exists in another indexed repo is flagged outsideWorkspace', () => {
  const otherRepo = fs.mkdtempSync(path.join(__dirname, '_fc-other-'));
  try {
    fs.mkdirSync(path.join(otherRepo, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(otherRepo, 'lib', 'only-here.ts'), 'export const x = 1;\n');
    const r = resolveAgentPath('lib/only-here.ts', [otherRepo, WORKSPACE], WORKSPACE);
    assert.equal(r.exists, true);
    assert.equal(r.outsideWorkspace, true,
      'run-bash cwd is the workspace, so the agent must not sed -n a path from another repo');
  } finally {
    fs.rmSync(otherRepo, { recursive: true, force: true });
  }
});

test('handleFindCode hint tells the agent paths are workspace-relative', () => {
  const out = handleFindCode({ query: 'renderGutter' }, {
    userId: U, roots: [WORKSPACE], workspaceRoot: WORKSPACE,
  });
  assert.ok(out.symbols.length > 0);
  assert.match(out.hint, /relative to the workspace root/i);
});

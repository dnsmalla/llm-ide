# SCIP Code-Graph Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the extension ingest a user-supplied SCIP index so planner/code-sync agents ground in compiler-derived symbols and relationships, stored as FTS symbol rows (augmenting chunks) plus a SQLite node/edge graph for multi-hop traversal.

**Architecture:** A vendored `.mjs` port of graph-kit's `scipScanner` parses `scip print --json` output into canonical `CGData`. A new connector (`indexScip`) writes symbol rows into the existing `sources` FTS table (`kind='code'`, `meta.source='scip'`) and nodes/edges into new `code_graph_*` tables. A new graphkit query (`findRelatedSymbols`) seeds from the graph by query, expands over edges, and hydrates — wired additively into `code-sync` so each task gains a `symbols` field. All behind a new `POST /kb/ingest-scip` route.

**Tech Stack:** Node 20+ ESM (`.mjs`), better-sqlite3 (WAL+FTS5), Node's built-in test runner (`node --test`), no new npm dependencies.

## Global Constraints

- **ESM `.mjs` only** for server/kb/connectors/graphkit/agents code — `import`/`export`, no `require`.
- **userId-first** on every state-mutating (and read) helper; open with `requireUser(userId)`.
- **Reuse `kind: 'code'`** — do NOT introduce a new source kind (would require syncing `ALLOWED_SOURCE_KINDS`, the `search()` hydration set, and FTS triggers).
- **Transactional writes** — every multi-step DB mutation uses `db.transaction(...)`.
- **Errors:** domain/validation inside helpers → `throw new Error('<user-presentable message>')`; HTTP → `sendJSON(res, <status>, { error: { code: '<CODE>', message } })`; success envelope `{ ok: true, ...result }`.
- **Migration:** create `extension/kb/migrations/0025_scip_code_graph.sql` (4-digit prefix matching `^(\d{3,4})_([\w.-]+)\.sql$`); auto-discovered, no registry edit, no `migrations.mjs` change.
- **Server handshake:** add `'/kb/ingest-scip'` to the `ENDPOINTS` array (`extension/server.mjs`); bump `SERVER_API_VERSION` 20→21; do NOT add to `REQUIRED_ENDPOINTS` (no sidepanel caller in v1) and do NOT change `MIN_SERVER_API_VERSION` (stays 20).
- **Test env:** set `LLMIDE_JWT_SECRET` and `LLMIDE_VAULT_KEY` (≥48 chars each) + `NODE_ENV=test` before importing `kb/db.mjs`; temp DB via `process.env.LLMIDE_DB_PATH`; register a real user via `users.registerUser(db.getDb(), {...}).id` (never synthesize a userId).
- **Runner:** `node --test --experimental-strip-types tests/<file>.test.mjs` from `extension/`.
- **Commits:** Conventional Commits, one concern per commit.

## File Structure

- **Create** `extension/connectors/scip-scanner.mjs` — vendored parser (`loadScipIndex`, `parseScipJson`). Pure + `node:child_process` only.
- **Create** `extension/connectors/scip.mjs` — connector (`indexScip`), mirrors `git.mjs`.
- **Create** `extension/kb/code-graph.mjs` — graph store + traversal helpers; re-exported from `db.mjs` (mirrors the `db.mjs ↔ sources.mjs` split).
- **Create** `extension/kb/migrations/0025_scip_code_graph.sql` — `code_graph_nodes` + `code_graph_edges`.
- **Modify** `extension/kb/db.mjs` — add one `export { ... } from './code-graph.mjs';` line.
- **Modify** `extension/kb/router.mjs` — `POST /kb/ingest-scip` handler + import.
- **Modify** `extension/server.mjs` — `ENDPOINTS` entry + `SERVER_API_VERSION` bump.
- **Modify** `extension/graphkit/index.mjs` — export `findRelatedSymbols`.
- **Modify** `extension/graphkit/graph.mjs` — add `findRelatedSymbols`.
- **Modify** `extension/agents/code-sync.mjs` — add `symbols` per task via `findRelatedSymbols`.
- **Create** `extension/tests/fixtures/scip/sample.scip.json` — ported from graph-kit.
- **Create** tests: `scip-scanner.test.mjs`, `code-graph-migration.test.mjs`, `code-graph-store.test.mjs`, `scip-connector.test.mjs`, `kb-router-scip.test.mjs`, `code-sync-expand.test.mjs`.

---

### Task 1: Vendored SCIP scanner

Port graph-kit's `typescript/src/code/scipScanner.ts` to `.mjs` (no TS compile, no npm dep), with the ported fixture and a unit test mirroring graph-kit's own assertions.

**Files:**
- Create: `extension/connectors/scip-scanner.mjs`
- Create: `extension/tests/fixtures/scip/sample.scip.json`
- Test: `extension/tests/scip-scanner.test.mjs`

**Interfaces:**
- Produces: `loadScipIndex(scipPath: string): Promise<object>` and `parseScipJson(index: object): { nodes, edges, layers, tour }` from `./scip-scanner.mjs`. Consumed by Task 4.

- [ ] **Step 1: Create the fixture**

Create `extension/tests/fixtures/scip/sample.scip.json` (verbatim port of graph-kit's fixture):

```json
{
  "metadata": { "tool_info": { "name": "scip-typescript" } },
  "documents": [
    {
      "relative_path": "src/app.ts",
      "symbols": [
        { "symbol": "scip-typescript npm src app add()", "relationships": [] },
        { "symbol": "scip-typescript npm src app main()", "relationships": [
          { "symbol": "scip-typescript npm src app add()", "is_reference": true }
        ] }
      ],
      "occurrences": [
        { "symbol": "scip-typescript npm src app add()", "symbol_roles": 1, "range": [3, 9, 12], "enclosing_range": [3, 0, 5, 1] },
        { "symbol": "scip-typescript npm src app main()", "symbol_roles": 1, "range": [7, 9, 13], "enclosing_range": [7, 0, 11, 1] },
        { "symbol": "scip-typescript npm src app add()", "symbol_roles": 8, "range": [9, 2, 5] }
      ]
    },
    {
      "relative_path": "src/container.py",
      "language": "Python",
      "symbols": [
        { "symbol": "scip-python python container Container#", "display_name": "Container", "kind": 7, "documentation": ["A container class."], "relationships": [] },
        { "symbol": "scip-python python container Container#run().", "display_name": "run", "kind": 26, "relationships": [] }
      ],
      "occurrences": [
        { "symbol": "scip-python python container Container#", "symbol_roles": 1, "range": [1, 6, 15], "enclosing_range": [1, 0, 10, 1] },
        { "symbol": "scip-python python container Container#run().", "symbol_roles": 1, "range": [3, 6, 9], "enclosing_range": [3, 2, 5, 3] },
        { "symbol": "scip-typescript npm src app add()", "symbol_roles": 8, "range": [4, 4, 7] }
      ]
    }
  ],
  "external_symbols": []
}
```

- [ ] **Step 2: Write the failing test**

Create `extension/tests/scip-scanner.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseScipJson, loadScipIndex } from '../connectors/scip-scanner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'scip', 'sample.scip.json'), 'utf8'));

test('parseScipJson emits one definition node per symbol with provenance', () => {
  const graph = parseScipJson(fixture);
  const add = graph.nodes.find((n) => n.id === 'scip-typescript npm src app add()');
  assert.ok(add, 'add node exists');
  assert.equal(add.kind, 'symbol');
  assert.equal(add.metadata.source_file, 'src/app.ts');
  assert.equal(add.metadata.line, 'L3');
  assert.equal(add.metadata.language, '');
  assert.equal(graph.nodes.length, 4);
});

test('parseScipJson falls back to symbol-string title and populates fields an indexer sets', () => {
  const graph = parseScipJson(fixture);
  const container = graph.nodes.find((n) => n.id === 'scip-python python container Container#');
  assert.ok(container, 'Container node exists');
  assert.equal(container.title, 'Container');
  assert.equal(container.kind, 'classType');
  assert.equal(container.metadata.language, 'Python');
  assert.equal(container.metadata.doc, 'A container class.');
  const add = graph.nodes.find((n) => n.id === 'scip-typescript npm src app add()');
  assert.ok(add);
  assert.equal(add.title, 'add()');
});

test('parseScipJson emits a reference edge from enclosing def to the referenced symbol', () => {
  const graph = parseScipJson(fixture);
  const ref = graph.edges.find(
    (e) => e.fromId === 'scip-typescript npm src app main()' &&
           e.toId === 'scip-typescript npm src app add()',
  );
  assert.ok(ref, 'main references add');
  assert.equal(ref.kind, 'references');
  assert.equal(ref.confidence, 'EXTRACTED');
});

test('parseScipJson attributes a reference to the innermost enclosing scope, not an outer one', () => {
  const graph = parseScipJson(fixture);
  const fromMethod = graph.edges.find(
    (e) => e.fromId === 'scip-python python container Container#run().' &&
           e.toId === 'scip-typescript npm src app add()',
  );
  const fromClass = graph.edges.find(
    (e) => e.fromId === 'scip-python python container Container#' &&
           e.toId === 'scip-typescript npm src app add()',
  );
  assert.ok(fromMethod, 'reference attributes to the innermost method scope');
  assert.equal(fromMethod.kind, 'references');
  assert.equal(fromClass, undefined, 'reference must not also attribute to the outer class scope');
});

test('parseScipJson maps relationships to typed edges', () => {
  const graph = parseScipJson({
    documents: [{
      relative_path: 'src/impl.ts', language: 'TypeScript',
      symbols: [
        { symbol: 's Widget', display_name: 'Widget', kind: 7, relationships: [] },
        { symbol: 's Button', display_name: 'Button', kind: 7,
          relationships: [{ symbol: 's Widget', is_implementation: true }] },
      ],
      occurrences: [
        { symbol: 's Widget', symbol_roles: 1, range: [1, 0, 5, 0] },
        { symbol: 's Button', symbol_roles: 1, range: [7, 0, 10, 0] },
      ],
    }],
  });
  const impl = graph.edges.find((e) => e.fromId === 's Button' && e.toId === 's Widget');
  assert.ok(impl);
  assert.equal(impl.kind, 'implements');
  assert.equal(impl.confidence, 'EXTRACTED');
});

test('parseScipJson accepts a string-form kind enum', () => {
  const graph = parseScipJson({
    documents: [{
      relative_path: 'src/strkind.ts',
      symbols: [{ symbol: 's Greet', display_name: 'greet', kind: 'Function', relationships: [] }],
      occurrences: [{ symbol: 's Greet', symbol_roles: 1, range: [1, 0, 3] }],
    }],
  });
  const greet = graph.nodes.find((n) => n.id === 's Greet');
  assert.ok(greet);
  assert.equal(greet.kind, 'function');
});

test('loadScipIndex rejects when the scip binary is unavailable', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    await assert.rejects(() => loadScipIndex('ignored.scip'), /scip/);
  } finally {
    process.env.PATH = originalPath;
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/scip-scanner.test.mjs`
Expected: FAIL — `Cannot find module '.../connectors/scip-scanner.mjs'`.

- [ ] **Step 4: Write the scanner (ported from graph-kit's scipScanner.ts)**

Create `extension/connectors/scip-scanner.mjs`:

```js
// Vendored port of graph-kit's typescript/src/code/scipScanner.ts (graph-kit main,
// unreleased past 1.6.0). Turns a Sourcegraph SCIP index into graph-kit's canonical
// CGData { nodes, edges }. Self-contained (node:child_process only) so the extension
// needs no npm dependency on the unpublished @dnsmalla/graph-kit package. When graph-kit
// TS is published, swap this for an `import` behind the connector in scip.mjs.

import { spawn } from 'node:child_process';

/** Read a foreign-JSON field tolerating snake_case or camelCase. */
function field(o, snake, camel) {
  if (!o) return undefined;
  if (o[snake] !== undefined) return o[snake];
  return o[camel];
}

// SCIP `SymbolInformation.Kind` values used here. `scip print --json` may emit the
// numeric value or the string name — kindFromScip accepts both.
const SCIP_KIND_NAME_TO_NUMBER = {
  Class: 7, Constructor: 9, Interface: 21, Function: 17, Method: 26,
  Module: 29, Namespace: 30, Package: 35,
};

function kindFromScip(kind) {
  const numeric = typeof kind === 'string' ? SCIP_KIND_NAME_TO_NUMBER[kind] : kind;
  switch (numeric) {
    case 7: return 'classType';   // Class
    case 9: return 'classType';   // Constructor
    case 21: return 'classType';  // Interface
    case 17: return 'function';   // Function
    case 26: return 'function';   // Method
    case 29: return 'module';     // Module
    case 30: return 'module';     // Namespace
    case 35: return 'module';     // Package
    default: return 'symbol';
  }
}

/** Normalize a SCIP range array. 4-el [sL,sC,eL,eC] or 3-el [L,sC,eC]; else undefined. */
function linesFromRangeArray(arr) {
  if (!Array.isArray(arr)) return undefined;
  if (arr.length === 4 && typeof arr[0] === 'number' && typeof arr[2] === 'number') {
    return { startLine: arr[0], endLine: arr[2] };
  }
  if (arr.length === 3 && typeof arr[0] === 'number') {
    return { startLine: arr[0], endLine: arr[0] };
  }
  return undefined;
}

function occLines(occ, snakeField = 'range', camelField = snakeField) {
  return linesFromRangeArray(field(occ, snakeField, camelField));
}

export function parseScipJson(index) {
  const idx = index || {};
  const documents = field(idx, 'documents', 'documents') || [];
  const nodes = [];
  const edges = [];
  const seenDef = new Set();
  const seenEdge = new Set();

  const addEdge = (fromId, toId, kind) => {
    const key = `${fromId}${toId}${kind}`;
    if (fromId === toId || seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ fromId, toId, kind, confidence: 'EXTRACTED' });
  };

  for (const doc of documents) {
    const sourceFile = field(doc, 'relative_path', 'relativePath') || '';
    const language = field(doc, 'language', 'language') || '';
    const symbols = field(doc, 'symbols', 'symbols') || [];
    const occurrences = field(doc, 'occurrences', 'occurrences') || [];

    const defOccBySymbol = new Map();
    for (const o of occurrences) {
      const roles = field(o, 'symbol_roles', 'symbolRoles') || 0;
      if ((roles & 0x1) === 0) continue;
      const sid = field(o, 'symbol', 'symbol');
      if (sid && !defOccBySymbol.has(sid)) defOccBySymbol.set(sid, o);
    }

    const enclosingLinesBySymbol = new Map();
    for (const [sid, defOcc] of defOccBySymbol) {
      enclosingLinesBySymbol.set(sid, occLines(defOcc, 'enclosing_range', 'enclosingRange'));
    }

    for (const sym of symbols) {
      const symbolId = field(sym, 'symbol', 'symbol') || '';
      const displayName = field(sym, 'display_name', 'displayName');
      const kind = field(sym, 'kind', 'kind');
      const documentation = field(sym, 'documentation', 'documentation');

      const def = defOccBySymbol.get(symbolId);
      const lines = def ? occLines(def) : undefined;
      if (!seenDef.has(symbolId)) {
        seenDef.add(symbolId);
        nodes.push({
          id: symbolId,
          title: displayName || (symbolId.split(' ').pop() || symbolId),
          kind: kindFromScip(kind),
          metadata: {
            source_file: sourceFile,
            fileURL: `file://${sourceFile}`,
            line: `L${lines ? lines.startLine : 0}`,
            language,
            ...(documentation && documentation.length ? { doc: documentation.join('\n') } : {}),
            extracted_by: 'scip',
          },
        });
      }

      const relationships = field(sym, 'relationships', 'relationships') || [];
      for (const rel of relationships) {
        const relKind = field(rel, 'is_implementation', 'isImplementation') ? 'implements' : 'references';
        const relTarget = field(rel, 'symbol', 'symbol') || '';
        if (relTarget) addEdge(symbolId, relTarget, relKind);
      }
    }

    for (const occ of occurrences) {
      const roles = field(occ, 'symbol_roles', 'symbolRoles') || 0;
      if ((roles & 0x1) !== 0) continue; // skip definitions
      const target = field(occ, 'symbol', 'symbol');
      if (!target) continue;
      const occRange = occLines(occ);
      if (!occRange) continue;

      let enclosingId;
      let bestStart = -Infinity;
      for (const s of symbols) {
        const sid = field(s, 'symbol', 'symbol');
        if (!sid || sid === target) continue;
        const enc = enclosingLinesBySymbol.get(sid);
        if (!enc) continue;
        if (occRange.startLine >= enc.startLine && occRange.startLine <= enc.endLine && enc.startLine > bestStart) {
          bestStart = enc.startLine;
          enclosingId = sid;
        }
      }
      if (!enclosingId) continue;
      const edgeKind = (roles & 0x2) !== 0 ? 'imports' : 'references';
      addEdge(enclosingId, target, edgeKind);
    }
  }

  return { nodes, edges, layers: [], tour: [] };
}

export function loadScipIndex(scipPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('scip', ['print', '--json', scipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const settle = (fn) => { if (!settled) { settled = true; fn(); } };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => settle(() => reject(new Error(`scip CLI not available: ${e.message}`))));
    child.on('close', (code) => {
      settle(() => {
        if (code !== 0) return reject(new Error(`scip print exited ${code}: ${err}`));
        try { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error(`scip print emitted invalid JSON: ${e.message}`)); }
      });
    });
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/scip-scanner.test.mjs`
Expected: PASS (7 tests). These mirror graph-kit's own assertions — that parity IS the drift guard.

- [ ] **Step 6: Commit**

```bash
git add extension/connectors/scip-scanner.mjs extension/tests/scip-scanner.test.mjs extension/tests/fixtures/scip/sample.scip.json
git commit -m "feat(connectors): vendored SCIP scanner ported from graph-kit"
```

---

### Task 2: Migration 0025 — code-graph tables

**Files:**
- Create: `extension/kb/migrations/0025_scip_code_graph.sql`
- Test: `extension/tests/code-graph-migration.test.mjs`

**Interfaces:**
- Produces: tables `code_graph_nodes(user_id, repo_id, symbol_id, title, kind, source_file, line, language, doc)` and `code_graph_edges(user_id, repo_id, from_id, to_id, kind, confidence)`. Auto-applied on first `getDb()`.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/code-graph-migration.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-graph-migration-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

const db = await import('../kb/db.mjs');

test('migration 0025 creates code_graph_nodes and code_graph_edges with required columns', () => {
  const conn = db.getDb();
  const nodeCols = conn.prepare('PRAGMA table_info(code_graph_nodes)').all().map((c) => c.name);
  const edgeCols = conn.prepare('PRAGMA table_info(code_graph_edges)').all().map((c) => c.name);
  for (const c of ['user_id', 'repo_id', 'symbol_id', 'title', 'kind', 'source_file', 'line', 'language', 'doc']) {
    assert.ok(nodeCols.includes(c), `code_graph_nodes has ${c}`);
  }
  for (const c of ['user_id', 'repo_id', 'from_id', 'to_id', 'kind', 'confidence']) {
    assert.ok(edgeCols.includes(c), `code_graph_edges has ${c}`);
  }
  const applied = conn.prepare('SELECT version FROM schema_migrations WHERE version=25').get();
  assert.ok(applied, 'migration 0025 recorded as applied');
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/code-graph-migration.test.mjs`
Expected: FAIL — `SQLITE_ERROR: no such table: code_graph_nodes`.

- [ ] **Step 3: Write the migration**

Create `extension/kb/migrations/0025_scip_code_graph.sql`:

```sql
-- SCIP code-graph store. Nodes/edges from a Sourcegraph SCIP index, written by
-- connectors/scip.mjs indexScip and traversed by kb/code-graph.mjs expandSymbols.
-- Canonical CGData kinds (graph-kit) live in kind; repo_id is the resolved repo
-- path (provenance/snapshot scoping). Traversal is user-scoped by symbol_id, so
-- every row also carries user_id (per the per-user tenancy invariant).

CREATE TABLE IF NOT EXISTS code_graph_nodes (
  user_id     TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  symbol_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  source_file TEXT NOT NULL,
  line        INTEGER NOT NULL,
  language    TEXT,
  doc         TEXT,
  PRIMARY KEY (user_id, repo_id, symbol_id)
);
CREATE INDEX IF NOT EXISTS idx_cgn_user_title ON code_graph_nodes (user_id, title);
CREATE INDEX IF NOT EXISTS idx_cgn_user_sym   ON code_graph_nodes (user_id, symbol_id);

CREATE TABLE IF NOT EXISTS code_graph_edges (
  user_id     TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  confidence  TEXT NOT NULL DEFAULT 'EXTRACTED',
  PRIMARY KEY (user_id, repo_id, from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_cge_user_from ON code_graph_edges (user_id, from_id);
CREATE INDEX IF NOT EXISTS idx_cge_user_to   ON code_graph_edges (user_id, to_id);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/code-graph-migration.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/kb/migrations/0025_scip_code_graph.sql extension/tests/code-graph-migration.test.mjs
git commit -m "feat(kb): migration 0025 adds code_graph_nodes/edges tables"
```

---

### Task 3: KB graph store + traversal helpers

`kb/code-graph.mjs`, re-exported from `db.mjs` (mirrors the `db.mjs ↔ sources.mjs` split). `expandSymbols` is **user-scoped** (SCIP symbol ids are globally namespaced), so the agent layer can call it with `userId` only.

**Files:**
- Create: `extension/kb/code-graph.mjs`
- Modify: `extension/kb/db.mjs` (add one re-export line)
- Test: `extension/tests/code-graph-store.test.mjs`

**Interfaces:**
- Consumes: `getDb`, `requireUser` from `./db.mjs` (Task — existing); `writeCodeGraph` needs CGData from Task 1's `parseScipJson`.
- Produces (all userId-first, exported via `db.mjs`): `writeCodeGraph(userId, repoId, cg) → {nodes, edges}`; `clearCodeGraph(userId, repoId)`; `deleteScipSources(userId, repoId) → number`; `expandSymbols(userId, seedIds, {hops, edgeKinds}) → string[]`; `findCodeSymbolIds(userId, query, limit) → string[]`; `hydrateSymbols(userId, symbolIds) → object[]`; `getCodeGraphSnapshot(userId, repoId) → {nodes, edges}`. Consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/code-graph-store.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-graph-store-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

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
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/code-graph-store.test.mjs`
Expected: FAIL — `db.writeCodeGraph is not a function`.

- [ ] **Step 3: Write the helpers**

Create `extension/kb/code-graph.mjs`:

```js
// SCIP / code-graph node+edge store + traversal. Backs the multi-hop relationship
// queries the code-sync agent uses to ground tasks in compiler-derived symbols.
// Mirrors the db.mjs <-> sources.mjs split: defined here, re-exported from db.mjs.
// Every helper is userId-first (tenancy); writes are transactional.

import path from 'node:path';
import { getDb, requireUser } from './db.mjs';

const DEFAULT_EDGE_KINDS = ['implements', 'references', 'imports'];

/** Upsert CGData { nodes, edges } for a repo. Idempotent (INSERT OR IGNORE). */
export function writeCodeGraph(userId, repoId, cg) {
  requireUser(userId);
  if (!repoId || typeof repoId !== 'string') throw new Error('repoId is required');
  const nodes = (cg && cg.nodes) || [];
  const edges = (cg && cg.edges) || [];
  const db = getDb();
  const upsertNode = db.prepare(
    `INSERT OR IGNORE INTO code_graph_nodes
       (user_id, repo_id, symbol_id, title, kind, source_file, line, language, doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertEdge = db.prepare(
    `INSERT OR IGNORE INTO code_graph_edges
       (user_id, repo_id, from_id, to_id, kind, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const n of nodes) {
      const m = n.metadata || {};
      const lineNum = Number(String(m.line || 'L0').replace(/^L/, '')) || 0;
      upsertNode.run(userId, repoId, n.id, n.title || n.id, n.kind || 'symbol',
        m.source_file || '', lineNum, m.language || null, m.doc || null);
    }
    for (const e of edges) {
      upsertEdge.run(userId, repoId, e.fromId, e.toId, e.kind, e.confidence || 'EXTRACTED');
    }
  });
  tx();
  return { nodes: nodes.length, edges: edges.length };
}

/** Delete both graph tables for a repo (used by `replace`). */
export function clearCodeGraph(userId, repoId) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM code_graph_nodes WHERE user_id=? AND repo_id=?').run(userId, repoId);
    db.prepare('DELETE FROM code_graph_edges WHERE user_id=? AND repo_id=?').run(userId, repoId);
  });
  tx();
}

/**
 * Delete only SCIP-sourced `sources` rows for a repo — must NOT touch the augment
 * line-chunks. deleteSourcesByPrefix keys on ref-prefix alone and would wipe chunks
 * too, so this is a direct meta-filtered DELETE.
 */
export function deleteScipSources(userId, repoId) {
  requireUser(userId);
  const db = getDb();
  const info = db.prepare(
    `DELETE FROM sources
     WHERE user_id=? AND ref LIKE ? AND meta LIKE '%"source":"scip"%'`,
  ).run(userId, `${repoId}${path.sep}%`);
  return info.changes;
}

/** Multi-hop BFS over code_graph_edges from seed symbol ids (user-scoped). */
export function expandSymbols(userId, seedIds, { hops = 1, edgeKinds = DEFAULT_EDGE_KINDS } = {}) {
  requireUser(userId);
  if (!Array.isArray(seedIds) || seedIds.length === 0) return [];
  const db = getDb();
  const seen = new Set(seedIds);
  const out = [];
  let frontier = [...new Set(seedIds)];
  const kindPlace = edgeKinds.map(() => '?').join(',');
  for (let h = 0; h < hops; h++) {
    if (frontier.length === 0) break;
    const fromPlace = frontier.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT to_id FROM code_graph_edges
       WHERE user_id=? AND from_id IN (${fromPlace}) AND kind IN (${kindPlace})`,
    ).all(userId, ...frontier, ...edgeKinds);
    const next = [];
    for (const r of rows) {
      if (!seen.has(r.to_id)) { seen.add(r.to_id); next.push(r.to_id); out.push(r.to_id); }
    }
    frontier = next;
  }
  return out;
}

/** Seed symbol ids whose title or doc matches a free-text query. */
export function findCodeSymbolIds(userId, query, limit = 10) {
  requireUser(userId);
  if (!query) return [];
  const like = `%${query}%`;
  const rows = getDb().prepare(
    `SELECT symbol_id FROM code_graph_nodes
     WHERE user_id=? AND (title LIKE ? OR doc LIKE ?)
     LIMIT ?`,
  ).all(userId, like, like, limit);
  return rows.map((r) => r.symbol_id);
}

/** Hydrate symbol ids to node rows for agent context. */
export function hydrateSymbols(userId, symbolIds) {
  requireUser(userId);
  if (!Array.isArray(symbolIds) || symbolIds.length === 0) return [];
  const place = symbolIds.map(() => '?').join(',');
  return getDb().prepare(
    `SELECT symbol_id, title, kind, source_file, line FROM code_graph_nodes
     WHERE user_id=? AND symbol_id IN (${place})`,
  ).all(userId, ...symbolIds);
}

/** All nodes/edges for a repo (verification / future Mac read). */
export function getCodeGraphSnapshot(userId, repoId) {
  requireUser(userId);
  const db = getDb();
  return {
    nodes: db.prepare(
      'SELECT symbol_id, title, kind, source_file, line, language, doc FROM code_graph_nodes WHERE user_id=? AND repo_id=?',
    ).all(userId, repoId),
    edges: db.prepare(
      'SELECT from_id, to_id, kind, confidence FROM code_graph_edges WHERE user_id=? AND repo_id=?',
    ).all(userId, repoId),
  };
}
```

- [ ] **Step 4: Re-export from db.mjs**

In `extension/kb/db.mjs`, alongside the existing re-export lines (e.g. `export { ingestSources, deleteSourcesByPrefix } from './sources.mjs';` near line 426), add:

```js
export {
  writeCodeGraph, clearCodeGraph, deleteScipSources, expandSymbols,
  findCodeSymbolIds, hydrateSymbols, getCodeGraphSnapshot,
} from './code-graph.mjs';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/code-graph-store.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add extension/kb/code-graph.mjs extension/kb/db.mjs extension/tests/code-graph-store.test.mjs
git commit -m "feat(kb): code-graph store + multi-hop traversal helpers"
```

---

### Task 4: SCIP connector

`connectors/scip.mjs`, mirroring `indexLocalRepo`. `load` is injectable so tests feed the fixture without the real `scip` CLI.

**Files:**
- Create: `extension/connectors/scip.mjs`
- Test: `extension/tests/scip-connector.test.mjs`

**Interfaces:**
- Consumes: `loadScipIndex`, `parseScipJson` from `./scip-scanner.mjs` (Task 1); `ingestSources` from `../kb/db.mjs`; `writeCodeGraph`, `clearCodeGraph`, `deleteScipSources` from `../kb/code-graph.mjs` (Task 3).
- Produces: `indexScip(userId, repoPath, scipPath, { replace = true, load = loadScipIndex } = {})` → `{ repo, symbols, nodes, edges }`. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/scip-connector.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_scip-connector-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

const db = await import('../kb/db.mjs');
const { ingestSources } = await import('../kb/sources.mjs');
const users = await import('../server/users.mjs');
const { indexScip } = await import('../connectors/scip.mjs');

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'scip', 'sample.scip.json'), 'utf8'));
const fakeLoad = async () => fixture; // no real scip CLI needed

let U, REPO;
test('setup', () => {
  U = users.registerUser(db.getDb(), {
    email: `scip-conn-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c',
  }).id;
  REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-repo-'));
});

test('indexScip writes scip symbol rows + graph nodes/edges and returns counts', async () => {
  const res = await indexScip(U, REPO, 'ignored.scip', { load: fakeLoad });
  assert.equal(res.symbols, 4, 'one sources row per node');
  assert.equal(res.nodes, 4);
  assert.ok(res.edges >= 1, 'reference edges persisted');
  // symbol rows are kind=code, flagged source=scip
  const scipRows = db.getDb().prepare(
    "SELECT ref FROM sources WHERE user_id=? AND meta LIKE '%\"source\":\"scip\"%'",
  ).all(U);
  assert.equal(scipRows.length, 4);
  // graph tables populated
  assert.equal(db.getCodeGraphSnapshot(U, REPO).nodes.length, 4);
});

test('indexScip replace clears prior scip rows + graph but keeps chunks', async () => {
  // Seed a chunk row under the same repo that must survive replace.
  ingestSources(U, [
    { kind: 'code', ref: path.join(REPO, 'chunk.ts'), chunkIdx: 0, title: 'chunk', body: 'plain', meta: {} },
  ]);
  await indexScip(U, REPO, 'ignored.scip', { replace: true, load: fakeLoad });
  // chunk row still present
  const chunk = db.getDb().prepare("SELECT ref FROM sources WHERE user_id=? AND ref=?").get(U, path.join(REPO, 'chunk.ts'));
  assert.ok(chunk, 'chunk row survives replace');
  // scip rows present exactly once (no duplication from re-ingest)
  const scipCount = db.getDb().prepare(
    "SELECT COUNT(*) n FROM sources WHERE user_id=? AND meta LIKE '%\"source\":\"scip\"%'",
  ).get(U).n;
  assert.equal(scipCount, 4);
});

test('cleanup', () => {
  db.closeDb();
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch {}
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/scip-connector.test.mjs`
Expected: FAIL — `Cannot find module '.../connectors/scip.mjs'`.

- [ ] **Step 3: Write the connector**

Create `extension/connectors/scip.mjs`:

```js
// SCIP index connector — mirrors connectors/git.mjs indexLocalRepo. Shells to the
// Sourcegraph `scip` CLI (loadScipIndex), parses into CGData, then:
//   - writes one kind='code' sources row per symbol (meta.source='scip') — augment,
//     coexists with the git chunk index.
//   - persists nodes/edges into code_graph_* for multi-hop traversal.
// `load` is injectable so tests feed a fixture without the real CLI.

import path from 'node:path';
import fs from 'node:fs/promises';
import { ingestSources } from '../kb/db.mjs';
import { writeCodeGraph, clearCodeGraph, deleteScipSources } from '../kb/code-graph.mjs';
import { loadScipIndex, parseScipJson } from './scip-scanner.mjs';

export async function indexScip(userId, repoPath, scipPath, opts = {}) {
  const repoId = path.resolve(repoPath);
  let stat;
  try { stat = await fs.stat(repoId); }
  catch (err) { throw new Error(`Cannot access repo ${repoId}: ${err.message}`); }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${repoId}`);

  const load = opts.load || loadScipIndex;
  const cg = parseScipJson(await load(scipPath));

  const replace = opts.replace !== false;
  if (replace) {
    deleteScipSources(userId, repoId);
    clearCodeGraph(userId, repoId);
  }

  const items = [];
  let i = 0;
  for (const n of cg.nodes) {
    const m = n.metadata || {};
    const abs = m.source_file ? path.join(repoId, m.source_file) : repoId;
    const line = m.line || 'L0';
    const parts = [n.kind || 'symbol'];
    if (m.language) parts.push(m.language);
    if (m.doc) parts.push(m.doc);
    parts.push(n.id);
    items.push({
      kind: 'code',
      ref: `${abs}:${line}`,
      chunkIdx: i,
      title: n.title || n.id,
      body: parts.join(' · '),
      meta: { source: 'scip', symbol_id: n.id, kind: n.kind || 'symbol', language: m.language || '' },
    });
    i += 1;
  }

  const written = ingestSources(userId, items);
  const graph = writeCodeGraph(userId, repoId, cg);
  return { repo: repoId, symbols: written, nodes: graph.nodes, edges: graph.edges };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/scip-connector.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/connectors/scip.mjs extension/tests/scip-connector.test.mjs
git commit -m "feat(connectors): SCIP index connector (indexScip)"
```

---

### Task 5: HTTP endpoint + server wiring

`POST /kb/ingest-scip` mirroring `/kb/connect-git`. Endpoint tests cover the HTTP layer (validation, allowlist, error envelope) CLI-independently; the success-path counts are already proven by the Task 4 connector test.

**Files:**
- Modify: `extension/kb/router.mjs` (import + handler)
- Modify: `extension/server.mjs` (`ENDPOINTS` + `SERVER_API_VERSION`)
- Test: `extension/tests/kb-router-scip.test.mjs`

**Interfaces:**
- Consumes: `indexScip` from `../connectors/scip.mjs` (Task 4); `userRepoAllowlist` from `./db.mjs`; `sendJSON`, `readBody`, `parseJSON` from `../core/utils.mjs`.
- Produces: `POST /kb/ingest-scip` `{ repoPath, scipPath, replace? }` → `{ ok: true, repo, symbols, nodes, edges }`.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/kb-router-scip.test.mjs` (reuses the `makeReq`/`makeRes` pattern from `kb-router-path-traversal.test.mjs`):

```js
// HTTP-layer tests for POST /kb/ingest-scip. Covers validation, allowlist gate,
// and the error envelope. The success-path counts are proven by scip-connector.test.mjs
// (the router just wraps indexScip in { ok: true, ...result }).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-router-scip-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');
const users = await import('../server/users.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch {} }
  db.getDb();
}
function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
  };
}

test('POST /kb/ingest-scip 400 on missing fields (VALIDATION_FAILED)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `v-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  const res = makeRes();
  await handleKB(makeReq({ method: 'POST', url: '/kb/ingest-scip', body: { repoPath: '/tmp/x' }, userId: u.id }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res._body).error.code, 'VALIDATION_FAILED');
});

test('POST /kb/ingest-scip 403 when repoPath not allowlisted (PATH_NOT_APPROVED)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `d-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'd' });
  const res = makeRes();
  await handleKB(makeReq({ method: 'POST', url: '/kb/ingest-scip', body: { repoPath: '/tmp/not-approved', scipPath: '/tmp/x.scip' }, userId: u.id }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res._body).error.code, 'PATH_NOT_APPROVED');
});

test('POST /kb/ingest-scip 400 SCIP_INDEX_FAILED when scip cannot read the index', async () => {
  resetDb();
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-ok-'));
  try {
    const u = users.registerUser(db.getDb(), { email: `e-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'e' });
    db.addUserRepo(u.id, tmpRepo, 'scip-repo');
    const res = makeRes();
    // repo is allowlisted + is a real dir; scipPath is bogus so load() rejects
    // (scip CLI missing OR `scip print` non-zero) -> router returns the error envelope.
    await handleKB(makeReq({
      method: 'POST', url: '/kb/ingest-scip',
      body: { repoPath: tmpRepo, scipPath: '/nonexistent/file.scip' }, userId: u.id,
    }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res._body).error.code, 'SCIP_INDEX_FAILED');
  } finally {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch {}
  }
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/kb-router-scip.test.mjs`
Expected: FAIL — the route returns 404/false (no handler yet); assertions on `error.code` fail.

- [ ] **Step 3: Add the import to router.mjs**

In `extension/kb/router.mjs`, next to the existing `indexLocalRepo` import (the line importing from `'../connectors/git.mjs'`), add:

```js
import { indexScip } from '../connectors/scip.mjs';
```

- [ ] **Step 4: Add the route handler**

In `extension/kb/router.mjs`, inside `handleKB`'s `try { ... }` block, immediately after the `/kb/connect-git` `if`-block (around line 366), add:

```js
    if (req.method === 'POST' && url === '/kb/ingest-scip') {
      const body = parseJSON(await readBody(req));
      if (!body?.repoPath || typeof body.repoPath !== 'string' ||
          !body?.scipPath || typeof body.scipPath !== 'string') {
        sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'repoPath and scipPath are required' } });
        return true;
      }
      const nodePath = await import('node:path');
      const normalized = nodePath.resolve(body.repoPath);
      const allowlist = kb.userRepoAllowlist(userId);
      if (!allowlist.includes(normalized)) {
        sendJSON(res, 403, { error: { code: 'PATH_NOT_APPROVED', message: 'Repo path is not on your allow-list' } });
        return true;
      }
      try {
        const result = await indexScip(userId, normalized, body.scipPath, { replace: body.replace !== false });
        sendJSON(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJSON(res, 400, { error: { code: 'SCIP_INDEX_FAILED', message: err.message } });
      }
      return true;
    }
```

- [ ] **Step 5: Wire the server handshake**

In `extension/server.mjs`:
- Change `const SERVER_API_VERSION = 20;` → `const SERVER_API_VERSION = 21;`
- In the `ENDPOINTS` array, add `'/kb/ingest-scip',` on the line immediately after `'/kb/connect-git',`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/kb-router-scip.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add extension/kb/router.mjs extension/server.mjs extension/tests/kb-router-scip.test.mjs
git commit -m "feat(server): POST /kb/ingest-scip endpoint (apiVersion 21)"
```

> **Note:** If any existing test pins `SERVER_API_VERSION === 20` or the `/health` version field, update it to 21 in this same commit. The full suite in Task 7 will surface it if you miss one.

---

### Task 6: graphkit `findRelatedSymbols` + code-sync wiring

A graphkit orchestrator composes `findCodeSymbolIds` → `expandSymbols` → `hydrateSymbols` (all from Task 3), exposing a `(userId, query)` shape that matches `findRelatedCode`. `code-sync` adds a `symbols` field per task — additive; no graph ⇒ `[]`.

**Files:**
- Modify: `extension/graphkit/graph.mjs` (add `findRelatedSymbols`)
- Modify: `extension/graphkit/index.mjs` (export it)
- Modify: `extension/agents/code-sync.mjs` (wire it)
- Test: `extension/tests/code-sync-expand.test.mjs`

**Interfaces:**
- Consumes: `findCodeSymbolIds`, `expandSymbols`, `hydrateSymbols` from `../kb/db.mjs` (Task 3).
- Produces: `findRelatedSymbols(userId, query, { hops = 1, limit = 10 })` → array of `{ symbol_id, title, kind, source_file, line }`, exported from `graphkit/index.mjs`. Consumed by `code-sync.mjs`.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/code-sync-expand.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-sync-expand-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { codeSync } = await import('../agents/code-sync.mjs');
const { findRelatedSymbols } = await import('../graphkit/index.mjs');

const U = users.registerUser(db.getDb(), {
  email: `cse-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c',
}).id;

test('setup: a tiny graph where Widget <- Button <- Toolbar (references)', () => {
  db.writeCodeGraph(U, '/repo', {
    nodes: [
      { id: 's Widget', title: 'Widget', kind: 'classType', metadata: { source_file: 'w.ts', line: 'L1' } },
      { id: 's Button', title: 'Button', kind: 'classType', metadata: { source_file: 'b.ts', line: 'L2' } },
      { id: 's Toolbar', title: 'Toolbar', kind: 'classType', metadata: { source_file: 't.ts', line: 'L3' } },
    ],
    edges: [
      { fromId: 's Button', toId: 's Widget', kind: 'references', confidence: 'EXTRACTED' },
      { fromId: 's Toolbar', toId: 's Button', kind: 'references', confidence: 'EXTRACTED' },
    ],
  });
});

test('findRelatedSymbols seeds by title and expands 1 hop', () => {
  const syms = findRelatedSymbols(U, 'Button', { hops: 1, limit: 10 });
  const ids = syms.map((s) => s.symbol_id);
  assert.ok(ids.includes('s Button'), 'seed included');
  assert.ok(ids.includes('s Widget'), '1-hop reference target included');
});

test('codeSync attaches a symbols field expanded from each task query', () => {
  const plan = { tasks: [{ title: 'Fix the Button component', description: '' }] };
  const out = codeSync(U, { plan });
  const ids = out.tasks[0].symbols.map((s) => s.symbol_id);
  assert.ok(ids.includes('s Button'));
  assert.ok(ids.includes('s Widget'), 'relationship neighbor pulled in');
  // files field still present (unchanged behavior)
  assert.ok(Array.isArray(out.tasks[0].files));
});

test('codeSync with no graph returns empty symbols (no regression)', () => {
  const U2 = users.registerUser(db.getDb(), {
    email: `cse2-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c2',
  }).id;
  const out = codeSync(U2, { plan: { tasks: [{ title: 'anything', description: '' }] } });
  assert.deepEqual(out.tasks[0].symbols, []);
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/code-sync-expand.test.mjs`
Expected: FAIL — `findRelatedSymbols is not a function` (not exported).

- [ ] **Step 3: Add `findRelatedSymbols` to graph.mjs**

In `extension/graphkit/graph.mjs`, add the import of the three code-graph helpers from `../kb/db.mjs` (next to the existing `findContext` import) and append the function:

```js
import { findCodeSymbolIds, expandSymbols, hydrateSymbols } from '../kb/db.mjs';

/**
 * Compiler-derived symbol grounding for a free-text query. Seeds from symbol
 * titles/docs that match the query, expands `hops` over the code graph
 * (implements/references/imports), and hydrates to located symbols. Returns []
 * when no SCIP graph is present, so callers (code-sync) degrade gracefully.
 */
export function findRelatedSymbols(userId, query, { hops = 1, limit = 10 } = {}) {
  if (!query) return [];
  const seeds = findCodeSymbolIds(userId, query, limit);
  if (seeds.length === 0) return [];
  const expanded = expandSymbols(userId, seeds, { hops });
  const ids = [...new Set([...seeds, ...expanded])];
  return hydrateSymbols(userId, ids);
}
```

- [ ] **Step 4: Export it from the barrel**

In `extension/graphkit/index.mjs`, change the `graph.mjs` export line to include `findRelatedSymbols`:

```js
export { findRelatedCode, findGraphContext, rollupCodeRefs, findRelatedSymbols } from './graph.mjs';
```

- [ ] **Step 5: Wire code-sync**

Replace the body of `extension/agents/code-sync.mjs` with:

```js
import { findRelatedCode, findRelatedSymbols } from '../graphkit/index.mjs';

const FILES_PER_TASK = 5;

export function codeSync(userId, { plan }) {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  const tasks = plan.tasks.map((t) => {
    const q = [t.title, t.description].filter(Boolean).join(' ');
    return {
      ...t,
      files: findRelatedCode(userId, q, FILES_PER_TASK),
      symbols: findRelatedSymbols(userId, q, { hops: 1, limit: FILES_PER_TASK }),
    };
  });
  return { ...plan, tasks };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/code-sync-expand.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add extension/graphkit/graph.mjs extension/graphkit/index.mjs extension/agents/code-sync.mjs extension/tests/code-sync-expand.test.mjs
git commit -m "feat(graphkit): findRelatedSymbols wired into code-sync task grounding"
```

---

### Task 7: Docs + full regression

**Files:**
- Modify: `CHANGELOG.md` (root)
- No code changes.

**Interfaces:** none.

- [ ] **Step 1: Add a CHANGELOG entry**

In `CHANGELOG.md` at the root, under the top (Unreleased / next) section, add:

```
- SCIP code-graph ingestion: `POST /kb/ingest-scip` consumes a Sourcegraph `.scip`
  index (via the local `scip` CLI) into per-user symbol FTS rows + a node/edge graph,
  giving code-sync compiler-derived relationship grounding. Server API version 21.
```

- [ ] **Step 2: Lint**

Run: `cd extension && npm run lint`
Expected: 0 warnings (`--max-warnings 0`). Fix any style issues the new files trigger.

- [ ] **Step 3: Run the full extension test suite**

Run: `cd extension && npm test`
Expected: all tests PASS, including the 6 new files (scip-scanner, code-graph-migration, code-graph-store, scip-connector, kb-router-scip, code-sync-expand) and all pre-existing tests (regression — especially `sources-ingest-dedupe`, `kb-router-path-traversal`, `kb-router`).

- [ ] **Step 4: Sanity-build the server (no syntax/import errors at load)**

Run: `cd extension && node -e "import('./kb/router.mjs').then(()=>import('./server.mjs').catch(()=>{})).then(()=>console.log('modules load ok'))"`
Expected: prints `modules load ok` (confirms the new imports/exports resolve). Note: `server.mjs` may try to listen; the `.catch(()=>{})` swallows the bind — we only care that imports resolve.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for SCIP code-graph ingestion"
```

- [ ] **Step 6: (Optional, if `scip` CLI is installed) End-to-end smoke**

Only if `scip --version` succeeds on the machine: index a real repo with `scip-typescript index` (or equivalent) to `index.scip`, allowlist the repo via the existing connectors UI, then:

```bash
curl -sS -X POST http://127.0.0.1:3456/kb/ingest-scip \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LLMIDE_TOKEN" \
  -d '{"repoPath":"/abs/path/to/repo","scipPath":"/abs/index.scip"}'
```

Expected: `{ "ok": true, "repo": "...", "symbols": <N>, "nodes": <N>, "edges": <N> }`. If the `scip` CLI is absent, skip this step (covered by the connector test's injected `load`).

---

## Notes / Out of scope

- **`findSymbol(userId, repoId, name)` from the spec's illustrative query API is not implemented.** It had no consumer in this plan (the wiring seeds via `findCodeSymbolIds` over `code_graph_nodes` instead). Dropped per YAGNI; trivial to add later if a per-repo name lookup is needed.
- **Planner wiring is deferred.** `findGraphContext` feeds the plan prompt via `buildPrompt`; adding a `relatedSymbols` section is a prompt-template change best done separately. `findRelatedSymbols` is exported and ready for it.
- **Mac 3D graph (World B), running indexers from llm-ide, replacing chunks, and reconciling the drifted `extension/graphkit/types/graph.ts` are all out of scope** (see spec §Out of scope).
- **User-scoped traversal:** `expandSymbols` traverses by `symbol_id` across a user's repos. SCIP symbol ids are globally namespaced (`scip-<lang> <pkg> ...`), so cross-repo collisions are effectively impossible; the documented edge case (two repos defining identical symbol ids) is acceptable for v1.

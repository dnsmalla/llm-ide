# SCIP Code-Graph Ingestion (extension agent-grounding) — Design

**Date:** 2026-08-04
**Status:** Draft (awaiting implementation plan)
**Component:** extension server + KB (`extension/connectors/`, `extension/graphkit/`, `extension/kb/`)

## Goal

Let llm-ide ingest a Sourcegraph **SCIP** code-intelligence index (a `.scip` file the user supplies) so the planner and code-sync agents ground in **compiler-derived symbols and relationships** instead of only crude 80-line text chunks.

Concretely, a `.scip` index produces two artifacts in the extension's KB:
1. **Symbol rows** in the existing FTS code index (`sources`, `kind='code'`) — so `findRelatedCode` / `findGraphContext` return precise symbol hits with no query changes.
2. **A node/edge graph** in new SQLite tables — queryable for **multi-hop relationship traversal** (`implements` / `references` / `imports`), exposed via new `graphkit/` functions and wired into code-sync/planner.

## Background — current state

llm-ide has **two separate code-graph worlds**; this design targets the extension one.

- **Extension (Node) — FTS over chunks.** `extension/connectors/git.mjs:95` (`indexLocalRepo`) walks a repo, chunks files into 80-line windows, and ingests `kind='code'` rows into the KB SQLite `sources` table + `search` FTS5 virtual table. Triggered on-demand by `POST /kb/connect-git` (`extension/kb/router.mjs:341`), allowlist-gated via `userRepoAllowlist`. `git.mjs:5-7` explicitly reserves the chunker's public surface for a future tree-sitter-aware swap that never landed.
- **Agent consumers.** `extension/agents/code-sync.mjs` and `extension/agents/planner.mjs` ground via `findRelatedCode` / `findGraphContext` (`extension/graphkit/graph.mjs`), which wrap KB FTS (`findContext` in `extension/kb/db.mjs`) and roll hits up to one entry per file (`rollupCodeRefs`). Pure reads — no graph building on the extension side.
- **No `scanCode` on the extension.** `extension/graphkit/` is a *query + memory* layer (FTS reads + markdown memory rendering), not a graph builder. The real node/edge builder is the Swift `graph-kit` package used by the Mac app (out of scope here).
- **graph-kit SCIP work (unreleased).** graph-kit `main` (`465beac`, past the `1.6.0` tag llm-ide pins) added `typescript/src/code/scipScanner.ts`: `loadScipIndex(path)` shells to `scip print --json`, and `parseScipJson(index)` returns canonical `CGData { nodes, edges }` (node kinds `classType/function/module/symbol`; edge kinds `implements/references/imports`; `metadata.extracted_by='scip'`). `@dnsmalla/graph-kit` is **not published to npm** (404), and the SCIP work is untagged.
- **Schema drift (noted, out of scope).** `extension/graphkit/types/graph.ts` claims lock-step with Swift `CodeGraphModels.swift` but has drifted. The new graph tables use graph-kit's **canonical** `CGData` kinds, not the drifted `graph.ts`.

## Decisions (from brainstorming)

- **Target world: extension agent-grounding (World A).** SCIP feeds the SQLite code index that planner/code-sync search. The Mac 3D graph (World B) is out of scope. Rationale: the TS SCIP parser runs natively in the Node extension (no Swift port), and agent grounding is the higher-leverage consumer.
- **Index source: user supplies `.scip`, `scip` CLI present.** The user generates `.scip` files externally (scip-typescript, scip-python, lsif-go, …) and points llm-ide at them. The Sourcegraph `scip` CLI is available, so we reuse graph-kit's `loadScipIndex` shell-out (`scip print --json`) — no vendored protobuf reader.
- **Ingest strategy: augment.** SCIP symbol rows are added alongside existing line-chunks (both `kind='code'`). No regression; `findRelatedCode`'s per-file rollup merges them automatically.
- **Edges in scope: symbols + full graph store.** Persist the full `CGData` node/edge graph for multi-hop relationship traversal; wire traversal into code-sync/planner.
- **Parser source: vendor.** Port `scipScanner.ts` (~250 lines) to `extension/connectors/scip-scanner.mjs` (plain `.mjs`, no TS compile, matches the extension's runtime). `@dnsmalla/graph-kit` isn't on npm and the SCIP work is unreleased; vendoring avoids a publish gate and a fragile local file-link. The connector interface isolates this choice, so swapping to an npm dep later is mechanical.
- **Replace granularity: per `(user, repo)`.** Re-ingesting a repo's index replaces that repo's prior SCIP symbols + graph wholesale (delete-then-insert in one transaction). SCIP indexes a whole repo, so per-repo replace is the natural granularity — no per-row prefix bookkeeping.
- **Canonical kinds.** New graph tables use graph-kit's canonical `CGData` kinds from the vendored parser, not the drifted `graph.ts`.

## Architecture

```
POST /kb/ingest-scip { repoPath, scipPath, replace? }
   │
   ▼
kb/router.mjs  — allowlist gate (userRepoAllowlist, same as /kb/connect-git)
   │
   ▼
connectors/scip.mjs  indexScip(userId, repoPath, scipPath, { replace })
   ├── connectors/scip-scanner.mjs  loadScipIndex(scipPath)   [scip print --json]
   │                                parseScipJson(json) → { nodes, edges }   (vendored port)
   ├── resolve SCIP relative_path → absolute under repoPath
   ├── symbol rows → kb/db.mjs ingestSources()   (sources table, kind='code', meta.source='scip')   [augment FTS]
   ├── nodes/edges → kb/db.mjs writeCodeGraph()  (code_graph_nodes / code_graph_edges)             [graph store]
   └── return { symbols, nodes, edges }   (single transaction; replace = delete-then-insert)

plan time:
   code-sync.mjs / planner.mjs
      → findRelatedCode (FTS — now hits precise SCIP symbols too)
      → expandSymbols (graph BFS over code_graph_edges → implements/references neighbors)
      → attach to task context   (additive: no SCIP graph present ⇒ today's FTS-only behavior)
```

## Components

### `extension/connectors/scip-scanner.mjs` (vendored, new)
Direct port of graph-kit's `typescript/src/code/scipScanner.ts` to `.mjs`:
- `loadScipIndex(scipPath): Promise<object>` — `spawn('scip', ['print','--json',scipPath])`, collect stdout, `JSON.parse`. Rejects on spawn error / non-zero exit / invalid JSON (messages identical to the TS original).
- `parseScipJson(index): { nodes, edges }` — pure. Ports: `kindFromScip` (SCIP `SymbolKind` → `classType/function/module/symbol`), `linesFromRangeArray` (4- and 3-element range shapes), definition-node extraction, `relationships` → `implements`/`references` edges, and reference-edge resolution via innermost `enclosing_range` containment.
- `CGData` / `CGNode` / `CGEdge` shapes documented via JSDoc (no runtime types needed).

### `extension/connectors/scip.mjs` (new connector, mirrors `git.mjs`)
- `indexScip(userId, repoPath, scipPath, { replace = true })`:
  1. Normalize `repoPath` → `repoId` (absolute, `fs.realpath`, no trailing slash — the `repo_id` used in the graph tables and the allowlist key).
  2. `const cg = parseScipJson(await loadScipIndex(scipPath))`.
  3. Build symbol rows: one per node → `{ kind:'code', ref: <absPath>:L<line>, title: node.title, body: <kind · language · doc · symbol_id>, meta: { source:'scip', symbol_id, kind, language } }`. SCIP `relative_path` resolved against `repoPath`.
  4. `replace`: delete **only** prior SCIP symbol rows for `(userId, repoId)` via `deleteScipSources(userId, repoId)` — **must not** use `deleteSourcesByPrefix`, which keys on ref-prefix and would also delete the augment line-chunks. Also `clearCodeGraph(userId, repoId)`. Both inside one transaction.
  5. `ingestSources(userId, symbolRows)` + `writeCodeGraph(userId, repoId, cg)`.
  6. Return `{ symbols: symbolRows.length, nodes: cg.nodes.length, edges: cg.edges.length }`.

### SQLite — migration `extension/kb/migrations/0025_scip_code_graph.sql` (new)
```sql
CREATE TABLE IF NOT EXISTS code_graph_nodes (
  user_id    TEXT NOT NULL,
  repo_id    TEXT NOT NULL,            -- normalized repoPath
  symbol_id  TEXT NOT NULL,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- canonical CGData node kind
  source_file TEXT NOT NULL,
  line       INTEGER NOT NULL,
  language   TEXT,
  doc        TEXT,
  PRIMARY KEY (user_id, repo_id, symbol_id)
);
CREATE INDEX IF NOT EXISTS idx_cgn_lookup ON code_graph_nodes (user_id, repo_id, title);

CREATE TABLE IF NOT EXISTS code_graph_edges (
  user_id     TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- canonical CGData edge kind
  confidence  TEXT NOT NULL DEFAULT 'EXTRACTED',
  PRIMARY KEY (user_id, repo_id, from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_cge_from ON code_graph_edges (user_id, repo_id, from_id);
CREATE INDEX IF NOT EXISTS idx_cge_to   ON code_graph_edges (user_id, repo_id, to_id);
```
Per invariants: every row carries `user_id`; all multi-step writes use `db.transaction()`; WAL/FTS5 model unchanged.

### KB helpers — `extension/kb/db.mjs` (additions)
- `writeCodeGraph(userId, repoId, cg)` — transactional upsert of nodes/edges (INSERT … ON CONFLICT DO NOTHING for idempotency).
- `clearCodeGraph(userId, repoId)` — delete both graph tables for a repo (used by `replace`).
- `deleteScipSources(userId, repoId)` — delete `sources` rows where `ref` is under `repoId` **and** `meta` carries `"source":"scip"` (so chunk rows survive a SCIP re-ingest). Implemented as a direct `DELETE … WHERE user_id=? AND ref LIKE ? AND meta LIKE '%"source":"scip"%'`.
- `expandSymbols(userId, repoId, seedSymbolIds, { hops = 1, edgeKinds })` — iterative BFS over `code_graph_edges`, returns visited nodes.
- `findSymbol(userId, repoId, name)` — title lookup (exact then prefix).
- `getCodeGraphSnapshot(userId, repoId)` — all nodes/edges (for debugging / future Mac read).

### HTTP — `POST /kb/ingest-scip` (new route in `kb/router.mjs`)
- Body `{ repoPath, scipPath, replace? }`. Mirrors `/kb/connect-git`: normalize path, `userRepoAllowlist` gate (403 if not allowed), call `indexScip(userId, …)`.
- **Server invariant compliance:** add to `ENDPOINTS` array + bump `SERVER_API_VERSION` + add to `REQUIRED_ENDPOINTS` in `extension/src/sidepanel/App.tsx`.

### Query API — `extension/graphkit/` (additions, exported from `index.mjs`)
- Re-export `expandSymbols`, `findSymbol`, `getCodeGraphSnapshot` (thin wrappers over the `kb/db.mjs` helpers, userId-first). These belong in the query layer, not the connector.

### Consumer wiring — `extension/agents/`
- `code-sync.mjs`: after `findRelatedCode` yields seed files/symbols for a task, call `expandSymbols` to pull `implements`/`references` neighbors and attach them as additional context.
- `planner.mjs`: optionally annotate plan tasks with symbol relationships ("`X` implements `Y`") from the graph.
- **Additive only:** if no SCIP graph exists for the repo, behavior is unchanged (today's FTS-only grounding).

## Error handling

- **`scip` CLI missing** → `loadScipIndex` rejects with `"scip CLI not available: …"`; endpoint returns 400 with an install hint (`sourcegraph/scip`). No rows written.
- **`scip print` non-zero exit** → reject with `"scip print exited <code>: <stderr>"`; surfaced to caller; no ingest.
- **Invalid SCIP JSON** → `"scip print emitted invalid JSON: …"`; no ingest.
- **repoPath not in allowlist** → 403 (identical to `/kb/connect-git`).
- **No partial state:** parsing failures abort before any write; `replace` delete + insert run inside one `db.transaction()` — on any failure the repo's SCIP state is rolled back, not half-replaced.

## Testing

- **`parseScipJson` unit** — port graph-kit's `typescript/test/fixtures/scip/sample.scip.json` as the fixture; assert node kinds, `implements`/`references` edges, and innermost-enclosing reference-edge attribution. Mirror graph-kit's `scipScanner.test.ts` assertions.
- **Parity guard** — a test asserting the `.mjs` `parseScipJson` output matches graph-kit's TS output byte-for-byte on the fixture (guards vendored-copy drift).
- **`indexScip` connector** — with a mocked `loadScipIndex` (no real `scip` CLI): assert `sources` rows written with `meta.source='scip'`, `code_graph_*` rows written, `replace` clears prior SCIP rows, and `(userId)` / `(repoId)` scoping (one user's graph isn't visible to another).
- **`expandSymbols`** — multi-hop traversal over a seeded graph (2-hop `references`, `implements` fan-out).
- **Endpoint** — `/kb/ingest-scip` happy path (counts returned), allowlist rejection (403), missing-CLI error (400). Mirror existing route tests under `extension/tests/`.

## Out of scope (YAGNI)

- Mac 3D graph integration (World B) — the Swift `CGData` graph.
- Running SCIP indexers from llm-ide (user supplies the `.scip`).
- Replacing line-chunks (augment only).
- Reconciling the drifted `extension/graphkit/types/graph.ts` with Swift `CodeGraphModels.swift`.
- A sidepanel/Mac UI for triggering ingest — start API-driven (the endpoint), add UI when the flow proves out.

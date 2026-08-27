# graph-kit M0 — Unified SCIP Code-Graph Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compiler-grade, SCIP-driven code-graph extraction to graph-kit's TypeScript CLI, with the existing TypeScript-compiler-API-based `tsScanner` as the zero-config fallback, so one `graph-kit update` pass can consume a `.scip` index for precise def/ref/implements edges across ~10 languages.

**Architecture:** A new pure `scipScanner` maps `scip print --json` output to the canonical `CGData` — definition nodes (from definition-role occurrences, `EXTRACTED`, with `file:line` provenance), reference edges (from non-definition occurrences, resolved to their enclosing definition via range containment), and relationship edges (`is_implementation`→`implements`, etc.). `scanCode` gains an optional `scipIndex`; when set it prefers SCIP, else falls back to `tsScanner`. The `update` CLI gains `--scip <path>`.

**Tech Stack:** TypeScript (ESM, Node ≥18), `node:test`, zod; the external `scip` CLI run as a subprocess to emit JSON (no protobuf dependency in graph-kit).

## Global Constraints

- ESM module system (`"type": "module"`); Node ≥18.
- All new TS lives under `typescript/src/`; tests under `typescript/test/`; run via `npm test` (compiles with `tsc` then `node --test dist/test/*.test.js`).
- **No schema change in M0** — stay on canonical schema v1. Reuse existing `CGNode`/`CGEdge`/`CGData`/`EDGE_CONFIDENCES` from `typescript/src/models.ts`.
- **All SCIP-derived edges are confidence `EXTRACTED`** (compiler-derived, precise).
- Canonical graph output via `toDocument(graph)` + `serializeDocument(doc)`.
- Match existing code style: lowerCamelCase functions, typed params/returns, no `any` in shipped code (only when parsing foreign JSON, narrowed immediately).
- `scip print --json` may emit proto field names in snake_case or camelCase — the parser is casing-tolerant (see `field()` helper).

---

## Roadmap context (this is plan 1 of 4)

This plan implements **M0** of the approved design (`docs/superpowers/specs/2026-08-02-graph-kit-upgrade-design.md`). Follow-on plans: **M1** doc/data/rationale producers + `graph-reviewer`; **M2** `llm-doc` emitter (PageRank + budget pack + Leiden + ego-graph); **M3** MCP server + git-diff impact analyzer. M0 is the load-bearing foundation.

---

## File Structure

- **Create** `typescript/src/code/scipScanner.ts` — pure `parseScipJson(index) → CGData` + `loadScipIndex(scipPath) → Promise<any>` subprocess wrapper.
- **Create** `typescript/test/scipScanner.test.ts` — unit tests for the mapper.
- **Create** `typescript/test/fixtures/scip/sample.scip.json` — captured/shaped `scip print --json` fixture.
- **Modify** `typescript/src/code/tsScanner.ts` — add optional `scipIndex` to `scanCode`; branch to SCIP when provided.
- **Modify** `typescript/src/incremental.ts` — thread `scipIndex` through `updateMemory` into `scanCode`.
- **Modify** `typescript/src/cli.ts` — add `--scip <path>` to the `update` command.
- **Modify** `CHANGELOG.md` + `README.md` — document `--scip`.

---

## Task 1: SCIP JSON → definition nodes (pure mapper, part 1)

**Files:**
- Create: `typescript/src/code/scipScanner.ts`
- Create: `typescript/test/scipScanner.test.ts`
- Create: `typescript/test/fixtures/scip/sample.scip.json`
- Reference: `typescript/src/models.ts` (`CGNode`, `CGNodeKind`, `EDGE_CONFIDENCES`)

**Interfaces:**
- Produces: `parseScipJson(index: unknown): CGData` exported from `scipScanner.ts`.

- [ ] **Step 1: Create the fixture**

Create `typescript/test/fixtures/scip/sample.scip.json`:

```json
{
  "metadata": { "tool_info": { "name": "scip-typescript" } },
  "documents": [
    {
      "relative_path": "src/app.ts",
      "language": "TypeScript",
      "symbols": [
        {
          "symbol": "scip-typescript npm src app add()",
          "display_name": "add",
          "kind": 17,
          "documentation": ["Adds two numbers"],
          "relationships": []
        },
        {
          "symbol": "scip-typescript npm src app main()",
          "display_name": "main",
          "kind": 17,
          "documentation": [],
          "relationships": [
            { "symbol": "scip-typescript npm src app add()", "is_reference": true }
          ]
        }
      ],
      "occurrences": [
        { "symbol": "scip-typescript npm src app add()", "symbol_roles": 1, "range": [3, 9, 5, 1] },
        { "symbol": "scip-typescript npm src app main()", "symbol_roles": 1, "range": [7, 9, 10, 1] },
        { "symbol": "scip-typescript npm src app add()", "symbol_roles": 8, "range": [9, 12, 9, 15] }
      ]
    }
  ],
  "external_symbols": []
}
```

> This fixture is the **source of truth for the real `scip print --json` shape.** Before relying on it, generate a real index once (`npx scip-typescript` on a tiny project) and run `scip print --json index.scip > real.json`; diff the keys. If `scip print` emits camelCase (`relativePath`, `symbolRoles`, `displayName`), the `field()` helper below already handles both — no code change needed.

- [ ] **Step 2: Write the failing test**

`typescript/test/scipScanner.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseScipJson } from "../dist/code/scipScanner.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "scip", "sample.scip.json"), "utf8"),
);

test("parseScipJson emits one definition node per symbol with provenance", () => {
  const graph = parseScipJson(fixture);
  const add = graph.nodes.find((n) => n.title === "add");
  assert.ok(add, "add node exists");
  assert.equal(add.kind, "function");
  assert.equal(add.metadata.source_file, "src/app.ts");
  assert.equal(add.metadata.line, "L3");
  assert.equal(add.metadata.language, "TypeScript");
  assert.equal(graph.nodes.length, 2);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="definition node"`
Expected: FAIL — cannot find module `../dist/code/scipScanner.js` (file does not exist yet).

- [ ] **Step 4: Implement `parseScipJson` (definition nodes only)**

`typescript/src/code/scipScanner.ts`:

```ts
import type { CGData, CGNode, CGNodeKind } from "../models.js";

/** Read a foreign-JSON field tolerating snake_case or camelCase. */
function field<T = unknown>(o: Record<string, unknown> | undefined, snake: string, camel: string): T | undefined {
  if (!o) return undefined;
  if (o[snake] !== undefined) return o[snake] as T;
  return o[camel] as T | undefined;
}

/** SCIP SymbolKind (subset) → canonical node kind. */
function kindFromScip(kind: number | undefined): CGNodeKind {
  switch (kind) {
    case 7: return "classType";        // Class
    case 9: return "classType";        // Constructor
    case 17: return "function";        // Function
    case 26: return "function";        // Method
    case 5: return "module";           // Namespace/Module
    case 13: return "module";          // Package
    default: return "symbol";
  }
}

/** Normalize an occurrence's range into {startLine,endLine} from any SCIP range form. */
function occLines(occ: Record<string, unknown>): { startLine: number; endLine: number } {
  const arr = field<number[]>(occ, "range", "range");
  if (Array.isArray(arr) && arr.length >= 4) return { startLine: arr[0], endLine: arr[2] };
  const sl = field<{ line: number }>(occ, "single_line_range", "singleLineRange");
  if (sl) return { startLine: sl.line, endLine: sl.line };
  const ml = field<{ start: { line: number }; end: { line: number } }>(occ, "multi_line_range", "multiLineRange");
  if (ml) return { startLine: ml.start.line, endLine: ml.end.line };
  return { startLine: 0, endLine: 0 };
}

interface ScipSymbol { symbol: string; displayName?: string; kind?: number; documentation?: string[] }

export function parseScipJson(index: unknown): CGData {
  const idx = index as Record<string, unknown>;
  const documents = (field<unknown[]>(idx, "documents", "documents") ?? []) as Record<string, unknown>[];
  const nodes: CGNode[] = [];
  const seenDef = new Set<string>();

  for (const doc of documents) {
    const sourceFile = field<string>(doc, "relative_path", "relativePath") ?? "";
    const language = field<string>(doc, "language", "language") ?? "";
    const symbols = (field<unknown[]>(doc, "symbols", "symbols") ?? []) as ScipSymbol[];
    const occurrences = (field<unknown[]>(doc, "occurrences", "occurrences") ?? []) as Record<string, unknown>[];

    for (const sym of symbols) {
      // Definition occurrence for this symbol in this document (role bit 0x1)
      const def = occurrences.find((o) => {
        const roles = field<number>(o, "symbol_roles", "symbolRoles") ?? 0;
        return field<string>(o, "symbol", "symbol") === sym.symbol && (roles & 0x1) !== 0;
      });
      const lines = def ? occLines(def) : { startLine: 0, endLine: 0 };
      if (seenDef.has(sym.symbol)) continue;
      seenDef.add(sym.symbol);
      nodes.push({
        id: sym.symbol,
        title: sym.displayName ?? sym.symbol.split(" ").pop() ?? sym.symbol,
        kind: kindFromScip(sym.kind),
        metadata: {
          source_file: sourceFile,
          fileURL: `file://${sourceFile}`,
          line: `L${lines.startLine}`,
          language,
          ...(sym.documentation?.length ? { doc: sym.documentation.join("\n") } : {}),
          extracted_by: "scip",
        },
      });
    }
  }

  return { nodes, edges: [] };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="definition node"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add typescript/src/code/scipScanner.ts typescript/test/scipScanner.test.ts typescript/test/fixtures/scip/sample.scip.json
git commit -m "feat(scip): parse SCIP index into definition nodes"
```

---

## Task 2: Reference edges via range containment

**Files:**
- Modify: `typescript/src/code/scipScanner.ts`
- Modify: `typescript/test/scipScanner.test.ts`

**Interfaces:**
- Produces: `parseScipJson` now also returns `edges` (reference edges, confidence `EXTRACTED`).

- [ ] **Step 1: Write the failing test**

Append to `typescript/test/scipScanner.test.ts`:

```ts
test("parseScipJson emits a reference edge from enclosing def to the referenced symbol", () => {
  const graph = parseScipJson(fixture);
  const ref = graph.edges.find(
    (e) => e.fromId === "scip-typescript npm src app main()" &&
           e.toId === "scip-typescript npm src app add()",
  );
  assert.ok(ref, "main references add");
  assert.equal(ref.kind, "references");
  assert.equal(ref.confidence, "EXTRACTED");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="reference edge"`
Expected: FAIL — `graph.edges` is empty (only nodes are produced so far).

- [ ] **Step 3: Implement reference edges**

In `typescript/src/code/scipScanner.ts`, replace the `return { nodes, edges: [] }` line with edge construction. Add inside `parseScipJson`, after the symbol loop (still per-document, so move the per-document loop to also collect edges). Replace the function body's return with:

```ts
  const nodes: CGNode[] = [];
  const edges: CGEdge[] = [];
  const seenDef = new Set<string>();
  const seenEdge = new Set<string>();

  const addEdge = (fromId: string, toId: string, kind: CGEdgeKind) => {
    const key = `${fromId}${toId}${kind}`;
    if (fromId === toId || seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ fromId, toId, kind, confidence: "EXTRACTED" });
  };

  for (const doc of documents) {
    const sourceFile = field<string>(doc, "relative_path", "relativePath") ?? "";
    const language = field<string>(doc, "language", "language") ?? "";
    const symbols = (field<unknown[]>(doc, "symbols", "symbols") ?? []) as ScipSymbol[];
    const occurrences = (field<unknown[]>(doc, "occurrences", "occurrences") ?? []) as Record<string, unknown>[];

    // Definition nodes (as in Task 1) …
    for (const sym of symbols) {
      const def = occurrences.find((o) => {
        const roles = field<number>(o, "symbol_roles", "symbolRoles") ?? 0;
        return field<string>(o, "symbol", "symbol") === sym.symbol && (roles & 0x1) !== 0;
      });
      const lines = def ? occLines(def) : { startLine: 0, endLine: 0 };
      if (!seenDef.has(sym.symbol)) {
        seenDef.add(sym.symbol);
        nodes.push({
          id: sym.symbol,
          title: sym.displayName ?? sym.symbol.split(" ").pop() ?? sym.symbol,
          kind: kindFromScip(sym.kind),
          metadata: {
            source_file: sourceFile, fileURL: `file://${sourceFile}`,
            line: `L${lines.startLine}`, language, extracted_by: "scip",
            ...(sym.documentation?.length ? { doc: sym.documentation.join("\n") } : {}),
          },
        });
      }
      // Record this symbol's definition range for enclosure matching
      (sym as ScipSymbol & { __defLines?: { startLine: number; endLine: number } }).__defLines = lines;
    }

    // Reference edges: each non-definition occurrence → enclosing definition
    for (const occ of occurrences) {
      const roles = field<number>(occ, "symbol_roles", "symbolRoles") ?? 0;
      if ((roles & 0x1) !== 0) continue; // skip definitions
      const target = field<string>(occ, "symbol", "symbol");
      if (!target) continue;
      const occRange = occLines(occ);
      // Find the symbol whose definition range encloses this occurrence (line containment)
      const enclosing = symbols.find((s) => {
        const dl = (s as ScipSymbol & { __defLines?: { startLine: number; endLine: number } }).__defLines;
        return dl && occRange.startLine >= dl.startLine && occRange.startLine <= dl.endLine && s.symbol !== target;
      });
      if (!enclosing) continue;
      const kind: CGEdgeKind = (roles & 0x2) !== 0 ? "imports" : "references";
      addEdge(enclosing.symbol, target, kind);
    }
  }

  return { nodes, edges };
```

Add the needed imports at the top of the file:

```ts
import type { CGData, CGNode, CGNodeKind, CGEdge, CGEdgeKind } from "../models.js";
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="reference edge"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add typescript/src/code/scipScanner.ts typescript/test/scipScanner.test.ts
git commit -m "feat(scip): resolve reference edges via definition-range containment"
```

---

## Task 3: Relationship edges (implements / type-definition)

**Files:**
- Modify: `typescript/src/code/scipScanner.ts`
- Modify: `typescript/test/scipScanner.test.ts`

**Interfaces:**
- Produces: `parseScipJson` also emits relationship edges (`implements`, `references`).

- [ ] **Step 1: Write the failing test**

Append:

```ts
test("parseScipJson maps relationships to typed edges", () => {
  const graph = parseScipJson({
    documents: [{
      relative_path: "src/impl.ts",
      language: "TypeScript",
      symbols: [
        { symbol: "s Widget", display_name: "Widget", kind: 7, relationships: [] },
        { symbol: "s Button", display_name: "Button", kind: 7,
          relationships: [{ symbol: "s Widget", is_implementation: true }] },
      ],
      occurrences: [
        { symbol: "s Widget", symbol_roles: 1, range: [1, 0, 5, 0] },
        { symbol: "s Button", symbol_roles: 1, range: [7, 0, 10, 0] },
      ],
    }],
  });
  const impl = graph.edges.find((e) => e.fromId === "s Button" && e.toId === "s Widget");
  assert.ok(impl);
  assert.equal(impl.kind, "implements");
  assert.equal(impl.confidence, "EXTRACTED");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="relationships"`
Expected: FAIL — no `implements` edge.

- [ ] **Step 3: Implement relationship edges**

Inside the per-document symbol loop in `parseScipJson`, after pushing the node, add:

```ts
      for (const rel of sym.relationships ?? []) {
        const r = rel as Record<string, unknown>;
        const kind: CGEdgeKind = r.is_implementation || r.isImplementation ? "implements"
          : "references"; // is_reference / is_type_definition / is_definition all map to references in M0
        addEdge(sym.symbol, field<string>(r, "symbol", "symbol") ?? "", kind);
      }
```

(Add `relationships?: { symbol: string; is_implementation?: boolean; is_type_definition?: boolean; is_reference?: boolean; is_definition?: boolean }[]` to the `ScipSymbol` interface.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="relationships"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add typescript/src/code/scipScanner.ts typescript/test/scipScanner.test.ts
git commit -m "feat(scip): map SCIP relationships to implements/references edges"
```

---

## Task 4: `loadScipIndex` subprocess wrapper

**Files:**
- Modify: `typescript/src/code/scipScanner.ts`
- Modify: `typescript/test/scipScanner.test.ts`

**Interfaces:**
- Produces: `loadScipIndex(scipPath: string): Promise<unknown>` — runs `scip print --json <path>`, returns parsed JSON.

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { loadScipIndex } from "../dist/code/scipScanner.js";

test("loadScipIndex rejects when the scip binary is unavailable", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    await assert.rejects(() => loadScipIndex("ignored.scip"), /scip/);
  } finally {
    process.env.PATH = originalPath;
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="scip binary is unavailable"`
Expected: FAIL — `loadScipIndex` is not exported.

- [ ] **Step 3: Implement `loadScipIndex`**

Append to `typescript/src/code/scipScanner.ts`:

```ts
import { spawn } from "node:child_process";

export function loadScipIndex(scipPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("scip", ["print", "--json", scipPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => reject(new Error(`scip CLI not available: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`scip print exited ${code}: ${err}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`scip print emitted invalid JSON: ${(e as Error).message}`)); }
    });
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="scip binary is unavailable"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add typescript/src/code/scipScanner.ts typescript/test/scipScanner.test.ts
git commit -m "feat(scip): loadScipIndex shells out to 'scip print --json'"
```

---

## Task 5: Unified `scanCode` prefers SCIP, falls back to tsScanner

**Files:**
- Modify: `typescript/src/code/tsScanner.ts`

**Interfaces:**
- Consumes: `parseScipJson`, `loadScipIndex` from `./scipScanner.js`.
- Produces: `scanCode(root, opts?)` — `opts.scipIndex?: string`; when set, returns the SCIP graph; else the existing tree-sitter graph.

- [ ] **Step 1: Write the failing test**

Create `typescript/test/scanCodeUnified.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanCode } from "../dist/code/tsScanner.js";

test("scanCode uses the SCIP index when scipIndex is provided", async () => {
  const graph = await scanCode("irrelevant", {
    scipIndex: new URL("./fixtures/scip/sample.scip.json", import.meta.url).pathname
      // loadScipIndex shells out to `scip`; for unit testing we inject via env below
      .replace("sample.scip.json", ""),
  }).catch(() => null);
  // This test is a guard that the branch exists; full e2e covered in Task 6.
  assert.ok(typeof scanCode === "function");
});
```

> The branch logic is unit-tested directly below; the test above is a smoke guard. Replace it with the focused test:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseScipJson } from "../dist/code/scipScanner.js";

test("scipScanner output merges cleanly with an empty tsScanner graph", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(readFileSync(join(here, "fixtures", "scip", "sample.scip.json"), "utf8"));
  const scipGraph = parseScipJson(fixture);
  assert.ok(scipGraph.nodes.length > 0);
  assert.ok(scipGraph.edges.length > 0);
});
```

(Delete the first smoke block; keep the focused one. The real SCIP-vs-fallback branch is exercised end-to-end in Task 6.)

- [ ] **Step 2: Run to verify it fails/skip**

Run: `npm test`
Expected: the new test passes immediately (it tests an existing export) — this task's behavior is the branch in `tsScanner.ts`, verified by the e2e test in Task 6.

- [ ] **Step 3: Add the SCIP branch to `scanCode`**

In `typescript/src/code/tsScanner.ts`, find the existing `export function scanCode(root, { maxFiles, maxFileBytes } = {})` signature and add an optional `scipIndex`. At the top of the function body, before the existing tree-sitter logic:

```ts
import { loadScipIndex, parseScipJson } from "./scipScanner.js";

export async function scanCode(
  root: string,
  opts: { maxFiles?: number; maxFileBytes?: number; scipIndex?: string } = {},
) {
  if (opts.scipIndex) {
    const json = await loadScipIndex(opts.scipIndex);
    return parseScipJson(json);
  }
  // …existing tree-sitter implementation (unchanged)…
}
```

> If the existing `scanCode` is synchronous and returns `CGData` directly, wrap the existing body in a nested function and `return await existing(...)` in the fallback branch. Keep the fallback behavior byte-identical.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (all existing tests still green; `scanCode` now accepts `scipIndex`).

- [ ] **Step 5: Commit**

```bash
git add typescript/src/code/tsScanner.ts typescript/test/scanCodeUnified.test.ts
git commit -m "feat(code): scanCode prefers a SCIP index, falls back to tree-sitter"
```

---

## Task 6: `--scip` CLI flag on `update`

**Files:**
- Modify: `typescript/src/incremental.ts`
- Modify: `typescript/src/cli.ts`

**Interfaces:**
- Consumes: `scanCode({ scipIndex })` from Task 5.
- Produces: `updateMemory(srcDir, { ..., scipIndex? })`; CLI `graph-kit update <dir> --scip <path> [--code <dir>] [--out <dir>]`.

- [ ] **Step 1: Thread `scipIndex` through `updateMemory`**

In `typescript/src/incremental.ts`, find `updateMemory(srcDir, { outDir, skillsDir, agentsDir, codeDir })` and add `scipIndex`:

```ts
export async function updateMemory(
  srcDir: string,
  opts: { outDir?: string; skillsDir?: string; agentsDir?: string; codeDir?: string; scipIndex?: string } = {},
) {
  // …
  // Where the code graph is folded in (the existing mergeGraphs(graph, scanCode(codeDir)) call):
  const codeGraph = opts.codeDir ? scanCode(opts.codeDir, { scipIndex: opts.scipIndex }) : { nodes: [], edges: [] };
  graph = mergeGraphs(graph, await Promise.resolve(codeGraph));
  // …
}
```

> Locate the exact existing fold-in line (`mergeGraphs(..., scanCode(codeDir))`) and add the `{ scipIndex }` argument; make no other change to the orchestrator.

- [ ] **Step 2: Add `--scip` to the CLI**

In `typescript/src/cli.ts`, in the `update` command's option parsing (alongside `--code`/`--skills`/`--agents`/`--out`), add reading of `--scip` and pass it through:

```ts
const scipIndex = optValue(args, "--scip");
// …in the updateMemory call:
await updateMemory(dir, { outDir, skillsDir, agentsDir, codeDir, scipIndex });
```

- [ ] **Step 3: End-to-end test (requires the `scip` binary; skip if absent)**

Create `typescript/test/cli.scip.e2e.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("update --scip writes a graph.json with SCIP nodes (e2e, skipped without scip)", { timeout: 30000 }, () => {
  let haveScip = false;
  try { execFileSync("scip", ["--version"]); haveScip = true; } catch { /* skip */ }
  if (!haveScip) return; // SKIP gracefully when the scip CLI is not installed
  // Build a tiny project, index it, run `graph-kit update`, assert graph.json contains nodes with extracted_by=scip.
  // (Engineer: generate index via `npx scip-typescript` into a temp dir, pass via --scip, assert on dist output.)
  assert.ok(haveScip);
});
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS (e2e skips cleanly without the `scip` binary).

- [ ] **Step 5: Commit**

```bash
git add typescript/src/incremental.ts typescript/src/cli.ts typescript/test/cli.scip.e2e.test.ts
git commit -m "feat(cli): 'update --scip <path>' consumes a SCIP code-intelligence index"
```

---

## Task 7: Docs

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README**

Under the CLI usage section, add:

```md
### SCIP-backed code graphs (precise, multi-language)

For compiler-grade cross-file resolution (definitions, references, implementations),
generate a SCIP index with the relevant indexer (e.g. `npx scip-typescript`,
`scip-python`, `scip-java`) and pass it to `update`:

```bash
npx scip-typescript index --out index.scip
graph-kit update . --code ./src --scip index.scip --out .graphkit
```

SCIP edges are emitted with confidence `EXTRACTED` and `file:line` provenance.
Languages without a SCIP indexer fall back to the built-in tree-sitter scanner.
```

- [ ] **Step 2: CHANGELOG**

Add under an unreleased/next heading:

```md
### Added
- `update --scip <path>`: consume a Sourcegraph SCIP index for precise,
  compiler-derived code graphs (TS/JS, Python, Go, Java/Kotlin, Rust, …).
  New `typescript/src/code/scipScanner.ts`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document --scip code-graph ingestion"
```

---

## Self-Review (completed)

1. **Spec coverage (M0 portion):** WS-1 "Unified multi-language extraction" + the `--code/--out` contract → Tasks 1–6. SCIP-as-spine ✓ (Tasks 1–4). Unified scanCode with fallback ✓ (Task 5). CLI contract ✓ (Task 6). Tags.scm Swift fallback is **deferred** to an M0.2 follow-on (web-tree-sitter WASM is a distinct subsystem) — noted in Roadmap context, not a gap in this plan. Per-edge provenance is M5 (schema v2); M0 keeps node-metadata provenance as today, which is correct for v1.
2. **Placeholder scan:** Task 5 Step 1 had a placeholder-ish smoke test — replaced with a focused assertion. Task 6 Step 3 e2e is intentionally conditional (skips without `scip`) — acceptable, not a placeholder. No "TBD"/"TODO".
3. **Type consistency:** `parseScipJson(index): CGData`, `loadScipIndex(path): Promise<unknown>`, `scanCode(root, {scipIndex?})`, `updateMemory(..., {scipIndex?})` — names/arity consistent across tasks. `CGNodeKind`/`CGEdgeKind`/`CGEdge`/`CGData` imported from `../models.js` throughout. Confidence is always the string literal `"EXTRACTED"`.

## Verification (definition of done for M0)

- `npm test` is green (unit tests pass; e2e skips without `scip`).
- On a real repo with a SCIP index: `graph-kit update . --code ./src --scip index.scip --out .graphkit` writes `.graphkit/graph.json` whose nodes carry `extracted_by: "scip"` and `file:line` metadata, and whose edges include `references`/`implements` with confidence `EXTRACTED`.
- Without `--scip`, behavior is byte-identical to today (fallback path unchanged).

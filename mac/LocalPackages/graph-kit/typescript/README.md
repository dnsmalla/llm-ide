# @dnsmalla/graph-kit (TypeScript)

TypeScript implementation of the **GraphKit** canonical graph engine — turns **code**
and **text** into a typed node/edge graph. Schema-compatible with the Swift package: both
read and write the same [canonical JSON](../schema/SCHEMA.md), so a Swift app and a
Node/TS tool can exchange graphs.

> Status: **code → graph** (TS/JS scanner with call edges), **text → graph**,
> **index generation**, **schema validation**, and a **CLI** are implemented and
> tested (see [CHANGELOG](../CHANGELOG.md)).

## Install

```bash
npm install @dnsmalla/graph-kit
```

## Library

```ts
import {
  generateFromDir,        // markdown/text folder → memory graph
  generateIndex,          // CGData → markdown index
  parseDocumentString,    // validate + parse canonical JSON
  serializeDocument,      // CGData/GraphDocument → canonical JSON (sorted keys)
  toDocument,
} from "@dnsmalla/graph-kit";

const { graph } = generateFromDir("./docs");
const json = serializeDocument(toDocument(graph));   // schemaVersion + nodes + edges + …
const index = generateIndex(graph, { title: "Memory Index" });
```

All untrusted JSON goes through `parseDocumentString` / `parseDocument`, which validate
against the canonical schema (zod) and reject unknown future `schemaVersion`s.

## CLI

```bash
# Incremental memory index → .graphkit/ (graph.json + index.md + cache.json).
# Re-chunks only CHANGED files; idempotent; .graphkit/ self-gitignores (local only).
graph-kit update ./docs --skills ./skills --agents ./agents

# Background: rebuild incrementally on every file change (debounced).
graph-kit watch ./docs --skills ./skills

# One-shot build to stdout / explicit paths
graph-kit memory ./docs --out graph.json --index INDEX.md

# Render an index from an existing graph; validate a graph against the schema
graph-kit index graph.json --out INDEX.md
graph-kit validate graph.json
```

### SCIP-backed code graphs (precise, multi-language)

For compiler-grade cross-file resolution (definitions, references, implementations),
generate a SCIP index with the relevant indexer (e.g. `npx scip-typescript`,
`scip-python`, `scip-java`) and pass it to `update`:

```bash
npx scip-typescript index --out index.scip
graph-kit update . --code ./src --scip index.scip --out .graphkit
```

SCIP edges are emitted with confidence `EXTRACTED` and `file:line` provenance.
TypeScript/JavaScript fall back to the built-in TypeScript-compiler-API scanner; other languages produce no code graph without a SCIP index.

`update` is the workhorse: wire it to a git post-commit hook or a watcher so memory
refreshes in the background as code changes, cheaply (unchanged files are never re-read).

Because the CLI speaks the canonical JSON contract, **non-Swift consumers** (e.g. the
auto-system Node/TS memory graph) can produce and read GraphKit graphs without linking the
Swift library.

## What this package does (and doesn't, yet)

| Capability | Status |
|---|---|
| Canonical model + zod validation (`CGNode`/`CGEdge`/`CGData`/`GraphDocument`) | ✅ |
| Text → graph (`generateFromDir`/`generateFromFiles`) — headings, wiki-links, tags, title links | ✅ |
| Index generation (`generateIndex`) | ✅ |
| Incremental updates + manifest (`updateMemory`, idempotent) | ✅ |
| Skill/agent linking (`scanSkills`/`scanAgents`/`mergeCapabilities`) | ✅ |
| CLI (`memory` / `update` / `watch` / `index` / `validate`) | ✅ |
| Local-only `.graphkit/` artifacts (self-gitignored) | ✅ |
| Code → graph (TS/JS via the TypeScript compiler API: files, imports, symbols, inherits/implements, calls) | ✅ |

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # build + node:test (incl. cross-language fixture conformance)
```

Tests include `test/conformance.test.ts`, which loads the **shared** fixtures from
`../schema/fixtures/` — the same files the Swift `GraphDocumentCodableTests` validate — so
both implementations stay pinned to one schema.

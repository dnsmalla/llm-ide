# GraphKit (experimental scaffold)

TypeScript service layer for knowledge-graph automation — **not wired to the production server** (`extension/server.mjs`).

## Status

| Component | Production use |
|-----------|----------------|
| `graph.mjs`, `memory.mjs`, `memory-writer.mjs`, `index.mjs` | Used by server agents and KB ingest |
| `services/*.ts` (automation, note, graph, memory) | **Test-only** — Phase 2 scaffold; no server routes import them |
| `GraphService.findRelatedCode()` | Stub — returns `[]` until FTS wiring lands |

## Running tests

```bash
cd extension && npm test -- graphkit/tests/
```

## Before wiring to production

1. Add server routes or agent hooks that import from `services/index.ts`
2. Implement `findRelatedCode` (currently TODO in `graph-service.ts`)
3. Remove or implement Phase 4 no-ops in `automation-service.ts`

Do not delete this folder without confirming no future Phase 2 plan — tests guard the intended API shape.

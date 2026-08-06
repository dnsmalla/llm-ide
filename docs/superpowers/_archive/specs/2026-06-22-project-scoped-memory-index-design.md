# Project-scoped three-index memory (code · doc · memory)

**Date:** 2026-06-22
**Status:** Approved design — pending implementation plan
**Scope:** macOS app (`KnowledgeGraphService`, Code Graph view) + a cross-subsystem read contract with the extension's memory reader.

## Problem

The knowledge graph already builds two tracks — a **code** graph (`StructureScanner` → `system/graph/`) and a **doc** graph (`MemoryGenerator`/InfiniteBrain) — and merges them. But three gaps mean the user's mental model ("code index + doc index → memory index, used for the All graph") isn't actually realized:

1. **The doc graph is never persisted.** It lives only in memory; there is no on-disk "doc index" symmetric with the code index in `system/graph/`.
2. **The agent memory artifact is not a real combination.** `KnowledgeGraphService.writeMemoryArtifact` writes `graphify-out/memory/repo.md` (the *code* graph's summary only) + `graph-notes.md` (cross-links only). The doc/InfiniteBrain *content* never reaches the agent's memory.
3. **"All" re-scans instead of combining.** The view's `generateAll` re-runs both the code scan and the doc generation from scratch every time, rather than combining the two already-built indexes.

## Goal

A **project-scoped** (never global) three-index model:

- **code index** ← code files
- **doc index** ← doc files
- **memory index** = code index ⊕ doc index

The **memory index is the single combined artifact** that (a) the agent reads as "Repository memory" and (b) the "All" graph renders. "All" becomes a *combination* of the two separately-built indexes, not a third independent scan.

## Storage layout — project-scoped, nothing global

| Index | Location | Change |
|---|---|---|
| Code index | `<repo>/system/graph/` (`index.md` + notes) on disk | none |
| Doc index | **in-session** (`KnowledgeGraphService` cache + doc fingerprint; `GraphSessionStore` `.data` entry) | none — already present |
| Memory index | `<repo>/graphify-out/memory/` on disk — `repo.md` (code) + `doc-notes.md` (doc) + `graph-notes.md` (cross-links) | **enhanced** (`doc-notes.md` is new) |

**Why the doc index is not persisted to disk:** `CGData` is `Codable` but `MemoryChunk` is not, and the chunks carry the `[[wikilinks]]` that produce the doc→code cross-links — so a persisted doc index would lose cross-links on reload. Nothing reads such a file except a hypothetical restart-reuse, and doc generation is fast markdown chunking (no LLM). So the doc index stays in-session (the existing fingerprint cache already gives within-session reuse), and the **combined memory index** is the project-scoped on-disk artifact. The three-index model holds: code index (disk) + doc index (in-session) → memory index (disk), which both the agent reads and "All" renders.

## Generation flow

In `KnowledgeGraphService.runOnce(codeRepoRoot:docRoots:memoryRoot:)` — the existing pipeline plus persistence and a richer combine:

1. **Code index** — incremental scan (unchanged) → `system/graph/`. Sets `codeGraph`.
2. **Doc index** — fingerprint-cached generation (unchanged), in-session. Sets `docGraph`/`docChunks`/`docCount`.
3. **Memory index** = `merge(codeGraph, docGraph, chunks)` (unchanged merge) → write `graphify-out/memory/`:
   - `repo.md` — code summary (as today).
   - `doc-notes.md` — doc/chunk summaries grouped by doc (**new**). The extension reader's allow-list gains this filename (see Cross-subsystem contract).
   - `graph-notes.md` — counts + doc→code cross-links (as today).

## "All" graph consumption

`generateAll` (Code Graph view) builds the "All" graph by **combining the already-built code and doc indexes** rather than re-scanning:

- Use the cached/persisted **code** graph if fresh (the contended-scan fallback already added); otherwise build just the code index.
- Use the cached/persisted **doc** graph if the doc fingerprint is unchanged (reuse mechanism already added); otherwise build just the doc index.
- Combine via the existing `merge()`, lay out, display.

So "All" = `merge(code index, doc index)` over the two indexes the user generated separately — never a redundant double-scan when both are fresh.

## Data flow

```
code files ──StructureScanner──▶ code index (system/graph/, disk) ─┐
                                                                    ├─ merge ─▶ memory index (graphify-out/memory/, disk)
doc files  ──MemoryGenerator───▶ doc index (in-session) ───────────┘                    │
                                                                                        ├─▶ agent "Repository memory" (extension reads)
                                                                                        └─▶ "All" graph (view renders)
```

## Cross-subsystem contract (important)

The extension's `extension/graphkit/memory.mjs` (`renderGraphifyMemory`) reads a fixed allow-list inside `<repo>/graphify-out/memory/`: `repo.md`, `graph-notes.md`, and `.md` files under `bugs/` and `q&a/`. Surfacing doc content adds `doc-notes.md` to that allow-list (one `tryAdd` line). The Mac writer and the extension reader must ship together — this is the one place the change crosses the Mac↔extension boundary.

## Error handling

- A failed `doc-notes.md` write logs (consistent with `writeMemoryArtifact`'s existing error logging) and does not abort the run.
- The extension reader already tolerates a missing `doc-notes.md` (its `safeRead` returns empty), so the memory section degrades gracefully.
- Project switch resets caches (`resetCache`) as today; per-project paths guarantee no cross-project leakage.

## Testing

- **`renderDocNotes`** (Mac unit): given doc count + chunks, output groups chunks by doc title and lists heading paths.
- **`writeMemoryArtifact`** (Mac unit): writing to a temp dir produces a `doc-notes.md` whose contents include the doc summaries.
- **Extension reader** (extension unit): `renderGraphifyMemory` includes `doc-notes.md` content for an allow-listed repo (mirror `graphify-memory-tilde.test.mjs` setup).
- **"All" reuse** (compile + logic): the combine path uses the cached code + doc graphs without re-running the scans when fingerprints are fresh.
- Runtime/GUI behavior (canvas, agent memory content) verified by the user in the real app — the Mac GUI can't be driven headlessly here.

## Out of scope (YAGNI)

- No global/cross-project memory.
- No on-disk doc index (`MemoryChunk` isn't serializable; doc regen is cheap markdown chunking). Doc index stays in-session.
- No embeddings/LLM enrichment of doc notes.
- No FSEvents/file-watching (generation stays open/switch + timer + manual, as today).
- No change to the merge algorithm or cross-link logic.

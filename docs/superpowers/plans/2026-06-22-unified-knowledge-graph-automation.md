# Plan — Unified, automatic, incremental knowledge graph

**Status:** ✅ complete (Stages 0–5). Pipeline is live: auto-runs on project open/switch
+ periodic, gated to repos with an existing graph, and writes the agent-facing memory.
**Goal:** one knowledge graph for a project, built automatically and incrementally
from BOTH file types — code files via the Code graph, doc files via InfiniteBrain —
merged into a single graph, and used to generate the agent's repo memory. No manual
button.

## Pipeline

```
project files
  ├─ code extensions (.swift/.ts/.js/.py…) ──▶ Code graph   (CodeNoteService → StructureScanner)
  └─ doc  extensions (.md/.txt/.mdx…)       ──▶ InfiniteBrain (GraphKit.MemoryGenerator)
                        │
                        ▼
            MERGE → one CGData (+ doc→code cross-links by symbol name)
                        │
   on change: classify changed files → update only the affected track/part → regenerate memory
                        │
                   runs AUTOMATICALLY (project open/switch + file-watch + periodic)
```

Both generators already emit `GraphKit.CGData` (`nodes: [CGNode]`, `edges: [CGEdge]`,
public init, ids are stable Strings) → mergeable by id-dedup.

## Decisions (chosen defaults)

1. **Merge/cross-link:** start as two subgraphs unified in one `CGData`; add doc→code
   cross-links (doc chunk that whole-word names a code symbol → `references` edge) as a
   follow-on within Stage 2. Avoids blocking the merge on link heuristics.
2. **Consumer:** Stage 4 writes the generated memory **where the extension agent reads it**,
   fixing the dead `graphify-out/memory/` path (see the 2026-06-22 system re-review). So the
   automation finally feeds the agent, not just the Mac view.
3. **Trigger:** project open/switch + an FSEvents file-watcher (debounced) + a periodic
   safety refresh. Incremental, so the cost is bounded.

## Stages

- **Stage 0 — safety prereqs** ✅ (commit c408c31): `CodeNoteService` re-entrancy guard;
  `UAGraphView` code-graph Task stored in `runTask` (cancellable).
- **Stage 1 — classify & route** ✅ (this commit): `FileClassifier` partitions files into
  code/doc by extension (GraphKit `codeExtensions` + `MemoryGenerator.supportedExtensions`);
  `KnowledgeGraphService` runs the code track (`CodeNoteService`) and the doc track
  (`MemoryGenerator`) for a project and exposes both `CGData` outputs.
- **Stage 2 — merge** ✅: `KnowledgeGraphService.merge(code:doc:chunks:)` unions the two
  `CGData` (node-dedup by id) and adds doc→code cross-links — a doc chunk that names a code
  symbol via a `[[wikilink]]` or exact title match gets a `references` edge to that code node.
  Conservative (explicit links + exact titles only); fuzzy body-mention matching is a later
  refinement.
- **Stage 3 — incremental** ✅: doc-set change detection — `docSetFingerprint` (stat-only
  `path|size|mtime` hash over doc files) skips the doc-track recompute when nothing changed
  and reuses the cached graph; recomputes only on add/remove/edit. The code track is already
  per-file incremental via CodeNoteService's `scan-cache`. `resetCache()` clears on project
  switch. Note: true *per-doc* surgery (re-chunk only the changed doc, keep cross-doc edges)
  needs a seam in the graph-kit package — a follow-up there, since MemoryGenerator computes
  cross-chunk edges over the whole set. Doc chunking is cheap (no LLM), so full-recompute on
  any doc change is acceptable for now.
- **Stage 4 — generate memory** ✅ (option A): `writeMemoryArtifact` renders the merged graph
  to `<root>/graphify-out/memory/` — `repo.md` (reusing the code graph's `system/graph/index.md`)
  and `graph-notes.md` (counts + doc→code cross-links). Writes where the extension reader
  already targets, so the agent's "Repository memory" stops being empty with **no extension
  change**. Gated by a `memoryRoot` arg (the indexed repo).
- **Stage 5 — automate** ✅: `GraphAutoUpdater` (`@StateObject` in `LlmIdeMacApp`, injected,
  `.start()` from AppShell's `.task`) re-runs `KnowledgeGraphService` on `.activeProjectChanged`
  + a 15-min timer. GATED to repos that already have `system/graph/index.md` (first generation
  stays the manual button — "update only on the existing data"); `resetCache()` on project
  switch. Re-runs are cheap (code scan-cache + doc fingerprint skip). Trigger = open/switch +
  periodic (FSEvents not used, per the chosen option).

## Notes / open items

- Code-track repo resolution: the manual path uses `UAGraphView.codeTargetFolder` (selection-
  based). The automation resolves from `ProjectLayout(root).codeDir` + git-repo detection;
  refined in Stage 5.
- `~/InfiniteBrain` is the standalone origin app (code ported into the Mac app, e.g.
  `CGSimulation`/`QuadTree`); it is NOT a dependency here. All work is in this repo against
  the `GraphKit` (graph-kit) package.

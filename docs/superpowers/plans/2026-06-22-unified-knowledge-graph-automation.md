# Plan — Unified, automatic, incremental knowledge graph

**Status:** in progress (Stage 0 ✅, Stage 1 ✅, Stage 2 ✅)
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
- **Stage 3 — incremental:** per-doc chunk cache (hash-keyed, like the code `scan-cache`)
  so only changed docs re-chunk; on change, replace only affected nodes/edges + recompute
  touched cross-links.
- **Stage 4 — generate memory:** render the merged graph to the agent-facing memory artifact
  at the path the extension reads; update the extension reader if needed (Decision 2).
- **Stage 5 — automate:** `@StateObject` service in `LlmIdeMacApp`, `.start()` from AppShell;
  triggers per Decision 3; guarded against overlap.

## Notes / open items

- Code-track repo resolution: the manual path uses `UAGraphView.codeTargetFolder` (selection-
  based). The automation resolves from `ProjectLayout(root).codeDir` + git-repo detection;
  refined in Stage 5.
- `~/InfiniteBrain` is the standalone origin app (code ported into the Mac app, e.g.
  `CGSimulation`/`QuadTree`); it is NOT a dependency here. All work is in this repo against
  the `GraphKit` (graph-kit) package.

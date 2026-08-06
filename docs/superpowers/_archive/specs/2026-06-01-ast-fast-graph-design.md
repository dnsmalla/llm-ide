# Fast Deterministic Code Graph (AST + ripgrep)

**Date:** 2026-06-01
**Status:** Approved
**Approach:** Hybrid deterministic extraction (Python `ast` + ripgrep), instant graph, background LLM notes (Approach C)

## Summary

Make the Code Graph generation fast and accurate by splitting it into two
layers:

1. **Structural skeleton (deterministic, instant, 100% accurate):** the app
   extracts files, imports, functions, and module links itself — Python via a
   bundled stdlib `ast` script (the auto_refactor technique), everything else
   via ripgrep — then builds the graph directly from that structure. No LLM,
   no coding agent. The graph renders in seconds.
2. **Semantic notes (LLM, background, concurrent):** markdown notes
   (summary / purpose / relationships) are generated in the background and
   progressively enrich the already-visible graph. They never block it.

Together they form a complete, accurate knowledge base that a local agent can
query to perform safe automated code changes (the motivating use case).

## Motivation

The current pipeline derives the graph from LLM-written notes — one agent call
per batch, run sequentially (observed: "Analyzing 4 of 166 batches"). The
graph cannot appear until every note is written, so generation takes far too
long. Structure extraction is already deterministic (ripgrep), but the graph
is gated behind the slow note layer.

The fix is to **build the graph directly from the deterministic structure**
(`ScanResult` already carries files, resolved imports, and symbols) and treat
notes as optional background enrichment. The user also wants higher structural
accuracy than regex where it's cheap to get — hence real Python `ast` parsing
for `.py` files (reusing the technique in `/Users/dinesh.malla/auto_refactor/opt/ast_analyze.py`).

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Graph source | Deterministic structure, not LLM notes | Instant, exact, no hallucinated edges |
| Notes | LLM, background, concurrent (≤5) | Enrich without blocking the graph |
| Extraction engine | Hybrid: Python `ast` + ripgrep (Approach C) | Accurate Python AST where free; ripgrep covers TS/Swift/etc. |
| Where extraction runs | In the app via ProcessLauncher (no coding agent) | Fast, deterministic, testable |
| Import resolution | In Swift, per language | Creates the file→file module-link edges |
| Incremental | Per-file SHA-256 fingerprint (existing) | Only changed files re-noted |

## Architecture & Data Flow

```
CodeNoteService.generate(repoRoot)
  │
  │ PHASE 1 — EXTRACT STRUCTURE (app-run, no LLM, seconds)
  │   StructureScanner:
  │     • Python files → PythonASTExtractor (bundled `ast` script via python3)
  │     • Other files  → RipgrepExtractor (ripgrep + git)
  │     • ImportResolver resolves raw imports → internal file paths
  │   → ScanResult { files, imports (resolved), symbols }
  ▼
  │ PHASE 2 — BUILD GRAPH (pure Swift, instant)
  │   StructureGraphBuilder.build(scan, repoRoot) → CGData
  │     • file nodes, symbol nodes
  │     • import edges (file→file), contains edges (file→symbol)
  │   → publish CGData NOW → canvas renders immediately
  ▼
  │ PHASE 3 — ENRICH WITH NOTES (LLM agent, BACKGROUND, concurrent)
  │   Task.detached:
  │     withTaskGroup (≤5 concurrent) over file batches:
  │       agent writes .code-notes/notes/<path>.md (summary/purpose/links)
  │     as each batch lands → merge summary into node metadata,
  │       add semantic edges (calls/inherits/tested_by) on top, republish
  │   Graph already visible; notes fill in progressively.
```

Phase 2 publishes the graph and `generate` returns it immediately. Phase 3
continues after return via a detached task, publishing updates through
`@Published var graph` / `@Published var progress`.

## Structure Extraction

### PythonASTExtractor (for `.py`)
- Bundles `Resources/code_ast_scan.py` — a stdlib-`ast` analyzer replicating
  auto_refactor's `ast_analyze.py`: pure stdlib (`ast`, `json`, `pathlib`),
  zero third-party deps, deterministic. Walks the root, parses each `.py` with
  `ast.parse`, extracts via `ast.iter_child_nodes`: imports (`Import` /
  `ImportFrom` with module + name), classes (name, bases, methods), functions
  (name, args), with line numbers. Skips files that raise `SyntaxError`.
- Bundled as an SPM resource (the target already copies
  `Resources/generate_meeting_note.py`, so the mechanism exists).
- Invoked via `ProcessLauncher`: `/usr/bin/python3 <script> <repoRoot>` →
  JSON on stdout, decoded into the Python slice of `ScanResult`.

### RipgrepExtractor (for TS/TSX/JS/Swift/etc.)
- `git ls-files` (fallback: directory walk) honoring a default ignore list
  (`node_modules`, `.build`, `dist`, `.git`, lockfiles, binaries).
- `ripgrep` with per-language patterns:
  - imports: `import … from '…'`, `require('…')` (TS/JS); `import Foo` (Swift)
  - symbols: `function`/`class`/`const … =`/`export` (TS); `func`/`class`/
    `struct`/`enum`/`protocol` (Swift)
- LOC per file.

### ImportResolver (raw imports → internal file paths — the edges)
- **Python**: `a.b.c` → `a/b/c.py` or `a/b/c/__init__.py`, validated against
  the file set.
- **TS/JS**: relative (`./foo`, `../bar/baz`) resolved with extension/`index`
  probing; `tsconfig.json` `paths` aliases honored when present.
- **Swift**: no file-level imports (module/framework imports only) — Swift
  contributes file + symbol nodes but few file→file import edges; its
  relationships come later from note-level semantic links. (Explicit
  limitation so the graph isn't misleading.)
- Only resolved targets that exist in the file set become edges — no dangling
  or hallucinated edges.

### StructureScanner
Orchestrates both extractors + the resolver, producing the existing
`ScanResult { files, imports, symbols }` type. Runs in the app via
`ProcessLauncher` (mockable), no LLM.

## Deterministic Graph Builder

`StructureGraphBuilder.build(_ scan: ScanResult, repoRoot: URL) -> CGData` —
pure function, deterministic.

**Nodes:**
- file node per `scan.files`: `CGNode(id: "file:<path>", kind: .file,
  title: <filename>)`, metadata: `source_file`, `fileURL` (absolute, so the
  detail panel shows content on click), `language`, `loc`.
- symbol node per `scan.symbols`: `id: "function:<path>:<name>"` /
  `"class:<path>:<name>"`, kind `.function` / `.classType`, metadata
  `fileURL` + `line`.

**Edges:**
- import edges: each resolved `imports[file] → target` → `CGEdge(from:
  "file:<file>", to: "file:<target>", kind: .imports)`.
- contains edges: file → each of its symbols, `kind: .contains`.

Symbol nodes are always present; the existing `showSymbols` toggle in the view
controls their visibility so large files don't explode the default view.

Output goes to the existing `CodeGraphLayout.compute` → `CodeGraphCanvas`, so
it renders as soon as Phase 1 completes. The structural graph is the source of
truth for the skeleton; notes later add summaries + semantic edges on top.

## Background Note Enrichment

- Batches run through a `withTaskGroup` capped at 5 in-flight (replacing the
  current sequential `for` loop), launched in a detached background task after
  the graph is published.
- Each batch: the agent writes `.code-notes/notes/<path>.md` (existing format
  and `AnalyzePhase` prompt). When a batch lands, the service:
  1. reads those notes, sets each matching node's `summary` metadata,
  2. adds semantic edges declared in the note (`calls`, `inherits`,
     `tested_by`) on top of the structural skeleton, deduped,
  3. republishes the enriched `CGData`.
- Incremental + resilient (unchanged): per-file SHA-256 fingerprints so only
  changed files are re-noted; failed batches surfaced as a skipped count and
  excluded from fingerprints so they retry next run. A failed note only means
  that node lacks a summary — it is still in the graph.

## CodeNoteService Flow

```swift
func generate(repoRoot: URL) async -> Result<CGData, CodeNoteError> {
  progress = .extracting
  let scan = await StructureScanner(...).scan(repoRoot)      // hybrid, app-run
  progress = .buildingGraph
  let graph = StructureGraphBuilder.build(scan, repoRoot: repoRoot)
  self.graph = graph                                         // publish → render now
  progress = .enriching(done: 0, total: batchCount)
  Task.detached { [weak self] in
    await self?.enrichInBackground(scan: scan, repoRoot: repoRoot)  // ≤5 concurrent
  }
  return .success(graph)                                     // returns skeleton immediately
}
```

`Progress` gains: `.extracting`, `.buildingGraph`, `.enriching(done:total:)`,
`.complete(files:edges:skipped:)`.

## UI

The "Code Graph" tab:
- **Generate Code Graph** → graph appears within seconds (extracting →
  building → rendered).
- Non-blocking status line: "Enriching notes 40/166…". Graph is fully
  interactive during enrichment — pan/zoom, click a file to view its content
  via the existing `FileDetailView`; once a note lands the detail panel also
  shows the summary.
- The view observes `codeNoteService.$graph` and re-renders as enrichment
  republishes.

## Components & File Structure

New files (`mac/Sources/LlmIdeMac/CodeNotes/`):

| File | Responsibility |
|------|---------------|
| `StructureScanner.swift` | Orchestrate extractors + resolver → `ScanResult` |
| `PythonASTExtractor.swift` | Shell bundled `ast` script for `.py` |
| `Resources/code_ast_scan.py` | Bundled stdlib-`ast` analyzer (auto_refactor technique) |
| `RipgrepExtractor.swift` | Shell ripgrep/git for non-Python |
| `ImportResolver.swift` | Raw imports → internal file paths (per language) |
| `StructureGraphBuilder.swift` | `ScanResult` → `CGData` (pure) |

Reused/changed:
- `CodeNoteService` — new flow + background concurrency; gains `@Published var graph`.
- `ScanResult` — unchanged type, now produced by `StructureScanner`.
- `AnalyzePhase`, `BatchPlanner`, `Fingerprint`, `CodeNoteWriter` — kept for
  the note layer.
- `CodeNoteParser` — role narrows: no longer the graph source. Reused only to
  read notes and extract their *semantic* links (`calls`/`inherits`/
  `tested_by`) during enrichment. Its `derive(from:repoRoot:)` is no longer on
  the critical path.
- `EdgeRecovery` — obsolete and removed: import edges now come from the
  deterministic structure, so there are no LLM-dropped imports to recover.
  (Delete `EdgeRecovery.swift` + `EdgeRecoveryTests.swift` once unreferenced.)
- The old agent-run `ScanPhase` is replaced by `StructureScanner` (delete
  `ScanPhase.swift` + `ScanPhaseTests.swift` once unreferenced).
- `Package.swift` — add `Resources/code_ast_scan.py` to the target's resources.

## Error Handling

- No `python3` on the system → skip Python AST (those `.py` files still appear
  as plain file nodes via ripgrep enumeration), surface a one-line notice;
  graph still builds.
- No `ripgrep` → fall back to `git grep` / basic walk; degraded but non-fatal.
- Extraction never blocks the graph. Note failures are per-batch, surfaced as
  a skipped count, and retried next run.
- Malformed Python AST JSON or ripgrep output → skip the affected file, log,
  continue.

## Testing

Pure functions first, TDD:
- `ImportResolver` — Python dotted→path; TS relative/alias→path; dangling
  targets dropped.
- `StructureGraphBuilder` — `ScanResult` → correct file/symbol nodes, import +
  contains edges, `fileURL` set.
- `PythonASTExtractor` — decode a fixture of the bundled script's JSON into
  ScanResult fields.
- `RipgrepExtractor` — mock `ProcessLauncher`, verify patterns + parsing.
- `StructureScanner` — merges both extractors into one ScanResult.
- Background enrichment — mock launcher, verify concurrency cap, summary merge,
  semantic-edge dedup, and that the structural graph is returned before
  enrichment completes.

## Out of Scope

- The downstream "auto process" agent that consumes the knowledge base to add/
  delete/refactor code (this spec builds the knowledge base it will query).
- tree-sitter integration (Approach A) — a future accuracy upgrade; the
  extractor boundary (`StructureScanner`) is designed so a tree-sitter
  extractor could replace ripgrep later without changing the graph builder.
- Swift file→file edge inference beyond imports (would need SourceKit).

## Future Phases

- Swap `RipgrepExtractor` for a tree-sitter extractor behind the same
  `StructureScanner` interface for higher TS/Swift accuracy.
- Call-graph edges (function→function) via AST call-site analysis.
- Embeddings over notes for semantic "related" links.

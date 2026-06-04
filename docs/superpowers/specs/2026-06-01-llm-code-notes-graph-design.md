# LLM-Driven Code Notes & Graph System

**Date:** 2026-06-01
**Status:** Approved
**Approach:** App-orchestrated phased pipeline (Approach A)

## Summary

Build a new in-app code-understanding system for the llm-ide macOS app
that generates **InfiniteBrain-style atomic markdown notes** for project
code and derives an accurate knowledge graph from them. The Mac app
orchestrates the user's installed AI coding CLI (Claude Code, Gemini, etc.)
through a four-phase pipeline that combines **deterministic structural
extraction** (the agent runs `git ls-files` + ripgrep/ctags) with **LLM
semantic enrichment**, plus a deterministic edge-recovery pass. The
markdown notes are the source of truth; the graph is always derived from
their frontmatter links, so the two can never drift.

This supersedes the current read-only Understand-Anything consumer (which
cannot generate anything in-app) as the primary way to understand project
code. The UA reader code itself is left intact (see Out of Scope) so any
existing UA output can still be consumed.

## Motivation

The current `UARunner`/`UAParser` are read-only: the app can only display a
`knowledge-graph.json` produced by running `/understand` in Claude Code
separately. Problems the user reported:

1. **No in-app generation** — analysis happens outside the app.
2. **Edges miss / hallucinate** — pure-LLM graphs are unreliable.
3. **Shallow semantics** — weak summaries and architectural understanding.
4. **Poor structure/layout** — hard to read on large projects.
5. **No browsable markdown notes for code** — the InfiniteBrain "note per
   concept" artifact exists for docs (`MemoryGenerator`) but not for code.

The design steals the one idea that makes Understand-Anything's graphs
reliable — the hybrid deterministic-structure + LLM-semantics split with a
deterministic recovery pass — and unifies it with the project's
InfiniteBrain markdown-notes approach.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM runtime | Local AI CLI via ProcessLauncher + AICliTool | Uses the user's own subscription, no backend cost, full repo access |
| Structure extraction | Agent runs deterministic tools (git ls-files, ripgrep, ctags) | UA-style hybrid accuracy, no Node/tree-sitter dependency |
| Orchestration | App-orchestrated phased pipeline | In-app generation, progress UI, precise incremental control |
| Output artifact | Atomic markdown notes; graph derived from them | Notes are browsable and the source of truth; graph never drifts |
| Note granularity | Adaptive: module + file notes; split large files into per-symbol sub-notes | Clean default, manageable on big files |
| Re-run behavior | Incremental via per-file SHA-256 fingerprint | Fast/cheap re-runs; only changed files re-analyzed |
| Directory | New `.code-notes/` (UA reader left intact) | Distinct system; doesn't disturb existing UA/memory consumers |

## Architecture & Data Flow

```
CodeNoteService (Swift orchestrator)
  │
  │ Phase 1: SCAN  ──► agent runs git ls-files + ripgrep/ctags
  │                    returns scan.json {files, imports, symbols}
  ▼
  Phase 2: DIFF + BATCH (pure Swift)
  │   hash each file → unchanged/changed/deleted
  │   group changed files into import-connected batches + neighborMap
  ▼
  Phase 3: ANALYZE (one agent call per batch, ≤5 concurrent)
  │   agent gets {structural facts + neighbor context}
  │   writes one .md note per code unit + returns edges.json
  ▼
  Phase 4: MERGE + RECOVER + DERIVE (pure Swift)
  │   assemble notes; re-add dropped import edges from scan.json
  │   parse note frontmatter links → CGData; drop dangling edges
  ▼
  CGData ──► CodeGraphLayout ──► CodeGraphCanvas (existing renderer)
```

The agent is called only for specific, well-scoped jobs — never one long
unsupervised run. Phase 1 output is captured by the app and reused for
batching, fingerprinting, and grounding the Phase 3 LLM calls.

## The Markdown Note Format

Notes live in `<repo>/.code-notes/notes/`. Each is an atomic markdown file
with YAML frontmatter (machine-readable, drives the graph) and a body
(human + LLM readable).

### File note — `notes/extension/src/lib/anthropic.ts.md`

```markdown
---
id: file:extension/src/lib/anthropic.ts
kind: file
title: anthropic.ts
path: extension/src/lib/anthropic.ts
language: typescript
complexity: moderate
tags: [api, claude, llm]
content_hash: a1b2c3d4e5f6
symbols:
  - {name: generateSummary, kind: function, line: 12}
  - {name: askQuestion, kind: function, line: 48}
links:
  - {to: file:extension/src/lib/config.ts, kind: depends_on}
  - {to: file:extension/src/lib/kb.ts, kind: imports}
---

## Summary
Claude API client for generating meeting summaries and answering
questions about transcript content.

## Purpose
Wraps the Anthropic SDK with project-specific prompt templates and
retry/timeout handling. The single entry point for all LLM calls from
the extension sidepanel.

## Key Symbols
- `generateSummary(transcript)` — produces the structured meeting note
- `askQuestion(q, context)` — answers a user question over transcript

## Relationships
Depends on `config.ts` for the API base URL and auth token. Used by
the sidepanel chat and notes views.
```

### Module note — `notes/_modules/extension.md`

```markdown
---
id: module:extension
kind: module
title: Chrome Extension
path: extension/src
tags: [extension, frontend]
links:
  - {to: file:extension/src/lib/anthropic.ts, kind: contains}
  - {to: file:extension/src/background/service-worker.ts, kind: contains}
---

## Summary
Chrome extension for capturing meeting captions and generating notes.

## Architecture
Three layers: content scripts (caption scraping), background service
worker (message routing), and the React sidepanel (UI).
```

### Rules

- **Frontmatter `links` drives the graph** — each `{to, kind}` becomes a
  `CGEdge`. The body is for humans/agents only.
- **`content_hash`** is the per-file fingerprint for incremental re-runs.
- **Adaptive granularity:** a file exceeding ~400 LOC or ~15 symbols is
  split into per-symbol sub-notes (`id: function:<path>:<name>`), each
  linked to the parent file note via a `contains` edge.
- **Stable IDs** follow the existing `CGNode` convention (`file:`,
  `function:`, `module:`) so `CGNodeKind` mapping already works.
- Notes round-trip: re-runs only rewrite a note when its file's
  `content_hash` changed, preserving hand-edits to unchanged notes.

## The Four Phases

### Phase 1 — SCAN (one agent call)

The app sends a fixed prompt instructing the agent to:
1. Run `git ls-files` (fallback: recursive walk honoring a default ignore
   list — node_modules, .build, dist, etc.).
2. Run `ripgrep` for import/require statements per file.
3. Run `ripgrep` for symbol definitions per file (the reliable baseline,
   always available with ripgrep alone); use `ctags` to enrich symbol
   kinds when it is present.
4. Resolve imports to repo-internal paths, dropping external packages.

Returns one JSON blob, written to `.code-notes/scan.json`:

```json
{
  "files": [{"path": "src/a.ts", "language": "typescript", "loc": 120}],
  "imports": {"src/a.ts": ["src/b.ts", "src/c.ts"]},
  "symbols": {"src/a.ts": [{"name": "foo", "kind": "function", "line": 12}]}
}
```

This is the deterministic ground truth for all later phases.

### Phase 2 — DIFF + BATCH (pure Swift, no agent)

- SHA-256 each file's contents; compare against `fingerprints.json` from
  the last run.
- Classify each file: `unchanged` (skip), `changed`/`new` (re-analyze),
  `deleted` (remove note + edges).
- Group `changed`/`new` files into batches via connected components on the
  import graph (import-connected files in the same batch), capped at ~20
  files per batch.
- For each batch compute a **neighborMap**: 1-hop imported/importing files
  in *other* batches plus their exported symbols, so the agent can write
  cross-batch edges confidently.

### Phase 3 — ANALYZE (one agent call per batch, ≤5 concurrent)

For each batch the app sends the agent the structural facts for those files
(symbols, resolved imports) plus the neighborMap. The agent prompt is
narrowly scoped — **do not re-derive structure, only add semantics**:

- Write one `.md` note per file into `.code-notes/notes/` (summary,
  purpose, key symbols, relationships in the body; structural facts +
  links in the frontmatter).
- Split oversized files into per-symbol sub-notes.
- Return `edges-<batch>.json`: import edges transcribed 1:1 from the
  provided facts, plus semantic edges (`calls`, `inherits`, `tested_by`)
  the agent judged.

### Phase 4 — MERGE + RECOVER + DERIVE (pure Swift, no agent)

- Collect all note files and per-batch edge files.
- **Recovery pass:** for every import in `scan.json`, ensure a
  corresponding `imports` edge exists in the assembled set; re-add any the
  LLM dropped (tagged so it's auditable). Do not duplicate existing edges.
- **Derive `CGData`:** parse each note's frontmatter (`id`, `kind`,
  `links`) into `CGNode`/`CGEdge`. Drop dangling edges (missing target
  note). Normalize unrecognized node/edge kind strings to the nearest
  valid `CGNodeKind`/`CGEdgeKind`, defaulting to `.other`/`.relatedTo`.
- Write `fingerprints.json` and a top-level `index.md` (map of content).
- Feed `CGData` to the existing `CodeGraphLayout` → `CodeGraphCanvas`.

## Swift Components & File Structure

New code in a new `CodeNotes/` group. Existing `CGData`,
`CodeGraphLayout`, `CodeGraphCanvas`, `MarkdownRenderer`, `ProcessLauncher`,
and `AICliTool` are reused unchanged.

```
mac/Sources/LlmIdeMac/CodeNotes/
├── CodeNoteService.swift   — orchestrator: drives 4 phases, @Published
│                             progress, async + cancellable
├── ScanPhase.swift         — builds scan prompt, parses scan.json
├── ScanResult.swift        — Codable: files, imports, symbols
├── Fingerprint.swift       — SHA-256 per file; FingerprintStore
│                             (load/save); change classifier
├── BatchPlanner.swift      — connected-components batching + neighborMap
├── AnalyzePhase.swift      — builds per-batch prompt, parses edges JSON
├── CodeNote.swift          — note model + frontmatter Codable
├── CodeNoteWriter.swift    — write/read .md notes (YAML round-trip)
├── CodeNoteParser.swift    — notes/*.md → CGData (links → edges)
├── EdgeRecovery.swift      — re-add dropped import edges from scan.json
├── IndexWriter.swift       — generate index.md (map of content)
└── CodeNoteError.swift     — error enum
```

**Isolation / testability:**
- `Fingerprint`, `BatchPlanner`, `EdgeRecovery`, `CodeNoteParser`,
  `CodeNoteWriter` are pure functions → unit-testable with no agent.
- `ScanPhase`/`AnalyzePhase` use the existing `ProcessLauncher` +
  `AICliTool` seam (mockable, same pattern as the old `UARunner` tests).
- `CodeNoteService` is the only stateful/async coordinator.

### On-disk layout in the target repo

```
<repo>/.code-notes/
├── scan.json          — Phase 1 ground truth
├── fingerprints.json  — incremental cache
├── notes/             — InfiniteBrain notes (browsable)
│   ├── _modules/*.md
│   └── <path mirrors repo>/*.md
└── index.md           — map of content
```

`.code-notes/` is added to the project `.gitignore` (alongside the existing
`.understand-anything/` entry). The UA reader (`UAParser`/`UARunner`) and the
memory system (`MemoryStore`) are left untouched.

## UI Integration

The existing Code Graph view (`UAGraphView`) gains a new mode `codeNotes`
alongside the current `code` / `data` / `memory` modes.

- A **"Generate Code Notes"** button starts `CodeNoteService`. Progress is
  shown per phase: "Scanning… / Analyzing 3 of 8 batches… / Deriving
  graph…" via the service's `@Published` progress.
- On completion, the derived `CGData` renders on the existing canvas. A side
  list shows the browsable notes; clicking a note opens its `.md` in the
  detail panel via the existing `MarkdownRenderer`.
- **Re-run** is the same button; fingerprinting means it reports
  "Re-analyzing 2 changed files…" rather than re-processing the repo.

## Incremental Behavior

- Fingerprint = SHA-256 of file content, stored in `fingerprints.json`
  keyed by path.
- On re-run: only `changed`/`new` files go to Phase 3. `unchanged` files
  keep their existing note. `deleted` files have their note removed and
  edges cleaned up during derive.
- The graph always re-derives fully from all notes (cheap, pure Swift);
  only the expensive LLM analysis is incremental.

## Error Handling

- **No AI CLI installed** → `CodeNoteError.cliMissing`, shows the existing
  install hint via `AICliTool`.
- **Malformed agent JSON** → forgiving parser: normalize bad node/edge
  kinds, drop dangling edges, log what couldn't be fixed. One bad batch
  does not sink the run.
- **Agent timeout / non-zero exit on a batch** → that batch's files are
  marked failed and surfaced in progress ("2 files skipped"); other batches
  still produce a usable graph. No silent truncation — counts are shown.
- **Hand-edited notes** → the writer rewrites a note only when its file's
  `content_hash` changed, so body edits to unchanged files survive.

## Testing

TDD, pure functions first:

- `Fingerprint` — unchanged/changed/deleted classification from fixture
  hashes.
- `BatchPlanner` — import-connected files share a batch; neighborMap
  correctness.
- `CodeNoteParser` — frontmatter `links` → `CGEdge`; dangling-edge drop;
  bad-kind normalization.
- `EdgeRecovery` — dropped import re-added from scan.json; existing edges
  not duplicated.
- `CodeNoteWriter` — YAML frontmatter round-trips losslessly.
- `ScanPhase` / `AnalyzePhase` — mock `ProcessLauncher`, verify prompt args
  and JSON parsing.
- Integration — a tiny fixture repo (3 files, known imports) through the
  full pipeline with a mocked agent → assert the derived `CGData`.

## Out of Scope

- Replacing or removing the existing UA reader (`UAParser`/`UARunner`) —
  left intact so UA output can still be consumed.
- The doc-oriented `MemoryGenerator` and `MemoryStore` — untouched.
- Embeddings / semantic vector search over notes — possible future phase.
- Cross-repo graph merging.
- Rendering UA's layers/tours (separate concern).

## Future Phases (not built now)

- Embeddings over note bodies for semantic "related note" links.
- A chat-over-notes mode (ask questions answered from the note corpus).
- Architecture-level synthesis notes (auto-generated layer overviews).

# Graph as contract — design

**Date:** 2026-09-29 · **Status:** approved for Phase A + B planning · **Owner:** dnsmalla

## Problem

LLM-IDE builds a code/doc graph (graph-kit on the Mac, SCIP on the server) so
that LLM calls can look code up instead of reading whole files — cutting tokens
and, ideally, letting the system check what the model says. A verified review
(2026-09-29: producer, consumer and measurement passes, every finding re-checked
against code or the live DB read-only) found the concept is right but does not
deliver today:

- **The mechanism works in isolation.** `find-code` answers a question in
  ~170–740 tokens where whole-file reads cost ~4k–22k (measured payloads; the
  alternative is estimated at chars/4).
- **It is unmeasured.** `usage_ledger` has no retrieval/tool fields and an empty
  `request_id`; `skill_invoked` audit lines live only in `extension/kb/server.log`,
  which is rotated on every backend start. There is no evidence on this machine
  that `find-code` was ever called in a real turn.
- **The index is not trustworthy.**
  1. Every code-graph read filters on `user_id` only (`kb/code-graph.mjs`
     `expandSymbols`, `graphNeighbors`, `findCodeSymbolIds`,
     `searchCodeSymbols`, `hydrateSymbols`), so answers mix every repo the user
     ever graphed (measured: affiliate-repo hits in llm-ide answers).
  2. The Mac upload fingerprint hashes only `id|title|kind` + edges
     (`CodeGraphUploadService.swift:92-101`), so a line-shifting edit never
     re-uploads and server line numbers go stale silently.
  3. Nodes carry name/kind/file/start-line only; `declaration` is dropped by the
     regex extractor (graph-kit) and never uploaded (`LlmIdeAPIClient+CodeGraph.swift`),
     so `doc` is always empty for structure nodes.
  4. 1 `calls` edge exists in the whole DB (tree-sitter absent; regex scanner
     emits none) — "who calls X" is unanswerable.
  5. The FTS code index has no rows for this repo; its reindex deletes before an
     async walk outside any transaction (`connectors/git.mjs:107-110`).
- **Delivery wastes tokens.** Legacy `ask-internal` re-renders the 40 k-char
  repo-memory block the global agent already has (`loop.mjs` →
  `composeSystemContext`); v2 execute mode does not say "find-code first"
  (`execute-guidance.mjs`), unlike plan modes and legacy; codegen sends up to
  5 × 25 KB whole files and allows only 4096 output tokens for full-file JSON
  (`codegen.mjs:170-187`); the planner fetches an FTS code slice it never uses
  (`planner.mjs` `buildPrompt`). *Correction to the first-pass review:* planner
  context is trimmed to 5 × 200 chars per section by `formatContext`, so its
  injected cost is small — the waste is the unused query, not tokens.
- **Output is barely checked.** `PlanCitationCheck` checks only that cited files
  exist on disk, annotates, never blocks, and the model never sees it. Codegen
  does not check that a `modify` targets a file it was given (or an input that
  was truncated at 25 KB). Plan `owner` is not checked against participants.

## Principle

Treat the graph as a **contract** between the system and the model: the system
hands the model compact, repo-scoped, versioned facts; the model must cite them;
the system verifies the citations and feeds misses back. Every step is measured.

## Phases

| Phase | Goal | Where | Plan |
|---|---|---|---|
| **A — correctness** | Stop feeding wrong/duplicated context; enforce the cheap output checks | server + Mac app (no graph-kit) | `docs/superpowers/plans/2026-09-29-graph-contract-phase-a-correctness.md` |
| **B — measurement** | Durable per-turn retrieval accounting + golden-query retrieval test + report | server | `docs/superpowers/plans/2026-09-29-graph-contract-phase-b-measurement.md` |
| **C — output-control loop** | Server-side citation validator against `code_graph_nodes` (symbol exists, line in range), misses fed back for one revision, Execute blocked on unresolved citations; codegen/risk/planner cite ids | server + Mac | written after B lands (needs B's metrics to judge) |
| **D — richer graph** | Signatures + end lines kept by the regex extractor, stable symbol ids (path+parent+name), import-scoped call resolution, tree-sitter bundled or SCIP default, cache keyed on engine version, untracked files, graph `generated_at`/commit SHA | graph-kit + Mac | written after B; graph-kit changes need push + both pins bumped |

## Phase A decisions

- **Repo scoping rule.** Graph rows carry the *indexed clone's* path as
  `repo_id`, which is routinely not the open workspace (live: repo
  `~/Desktop/LLM/code/llm-ide`, workspace `~/Desktop/LLM`). Scope = every
  `repo_id` equal to, under, or containing the workspace root. If none match,
  fall back to unscoped (today's behaviour) — a different clone must still get
  answers, and `find-code` already flags `outsideWorkspace`. Scoping is an
  optional `repoIds` argument on each read; `null`/absent = unscoped, so
  `code-sync` and existing callers are untouched.
- **Fingerprint** covers `source_file`, `line` and `declaration` metadata; layout
  positions stay excluded.
- **Upload** sends `declaration` as `doc` when a node has no `doc`, so the server
  gets signatures wherever the extractor already produces them (Python today;
  every language once Phase D lands).
- **ask-internal** renders system context without repo memory (the global agent
  already has it; internal can call `search-kb`).
- **Execute guidance** gets the same "find-code first, read only those lines"
  rule as plan modes.
- **Codegen contract:** a `modify` must target a file that was provided and not
  truncated; others are dropped and reported in `notes`/`rejected`. Truncated
  inputs are labelled read-only in the prompt. Output cap 16 000 tokens. File
  labels are repo-relative via the user's allowed roots.
- **Planner:** `findContext` gains a `kinds` option; the planner skips `code`.
  `owner` outside the participant list becomes `null`.
- **FTS reindex:** delete + insert in one transaction after the walk.

## Deliberately out of scope for A/B

- Legacy per-message memory ranking (cache-busting): measure first (Phase B),
  then decide — v2 is the default engine and legacy is a fallback.
- `PlanCitationCheck` rework and any blocking behaviour: Phase C.
- Anything inside graph-kit: Phase D. The pending crash fix `ad4ac80` also needs
  a graph-kit push and both pins bumped.

## Success measures (Phase B makes these observable)

- Share of v2 turns that call `find-code` before `Read`/`Grep`.
- Retrieval chars per turn by tool, and turn input tokens with vs without
  retrieval.
- Golden-query suite: repo-scoped recall ≥ the fixture's expected hits, payload
  under budget.

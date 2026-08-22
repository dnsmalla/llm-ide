---
name: plan-director
description: Consolidate every plan collected in llm-doc/plans/ into one hierarchical master plan (PLAN.md) with stable task IDs, per-file and per-function breakdowns, cross-links, and enforced line limits
---

# Plan Director

## Overview

The plans in `llm-doc/plans/` accumulate one at a time, each written for a specific piece of work, with no links between them. This skill is the director: it reads all of them, resolves overlaps, and maintains **one** hierarchical master plan — `llm-doc/plans/PLAN.md` — so the project's whole intent is visible in a single indexed document.

**Announce at start:** "I'm using the plan-director skill to consolidate the plans."

## Inputs

- **Honor supplied paths first.** The task message may carry `Input: <dir>` (the plans directory to read) and `Write output to: <file>` (the master plan file) — these come from the Loop stage's editable Input/Output fields and **override every default below**. Relative paths resolve against the project root.
- Every `*.md` in the input directory — default `llm-doc/plans/` — except the master plan itself, `INDEX.md`, and `areas/` (the project root is the directory containing `system/project.json` — the repo root itself, or two levels up when the repo is checked out under `code/`; fall back to `docs/plans/` when no `llm-doc` exists).
- The structure index (`INDEX.md` beside the input plans; run the `plan-structure-index` skill first if it is missing or stale).
- The code the plans reference — read the actual files/functions before planning their change.

## Bootstrapping from code (no plans collected yet)

An empty input directory is not a reason to stop — derive the first master plan from the code itself, using the structure index as the map:

1. **Read the code-derived index**: the refactor candidates (files over 500 lines), the `proposed` rows in the Function Index, entry points, and the folder purposes.
2. **Find the real signals** in the code: oversized files and functions, duplicated logic, `TODO`/`FIXME`/`HACK` markers, modules with no test coverage, layering violations (imports that cross documented module boundaries), dead code, and missing or stale docs.
3. **Write the same PLAN.md structure** from those signals: one area per theme (e.g. "A1 Split oversized modules", "A2 Close the test gaps"), file plans for the concrete files, and function tasks with `Done when` checks — all with status `proposed` so a human can tell code-derived tasks from ones a person planned. Read every file before planning its change; a professional plan names real functions and real line-count/complexity evidence, never guesses.
4. Update INDEX.md so every proposed task ID appears in its Function Index rows, same as in the normal flow.

## Grounding future plans

The generated INDEX.md and PLAN.md are the standing context for **every plan written later** — by a person, the chat's plan mode, or the `writing-plans` skill:

- Start a new plan from the indexes: reuse their folder/file purposes and function IDs instead of re-deriving them, and check PLAN.md for an existing area that already covers (or conflicts with) the new work.
- Save the new plan into the input directory; the next run of this skill consolidates it into the hierarchy, links it to its area, and updates the registry — that is how one-off plans stay connected instead of piling up unlinked.

## PLAN.md contract

Frontmatter: `updated` (ISO date) and `commit` (short repo HEAD, if resolvable). Then:

```markdown
# Plan Director

## Goals
- G1 <one-line goal>            ← one per line, stable IDs

## Areas
### A1 <area name>  (goal: G1 · status: n/m tasks done)
Source plans: [<file>](<file>), …
<2–4 line summary of what this area achieves and why>

#### A1.F1 <relative/file/path>
<one line: what changes in this file and why>
- [ ] A1.F1.1 `functionName()` — <the change>. Done when: <observable check>.
- [x] A1.F1.2 `otherFn()` — <the change>. Done when: <check>.
```

## Rules

- **Stable IDs, never renumbered.** `A<n>` areas, `A<n>.F<m>` file plans, `A<n>.F<m>.<k>` function tasks. New items append; a completed task keeps its `[x]` row. IDs are what the Function Index in INDEX.md tracks — breaking one breaks tracking.
- **Function tasks are the unit.** Every task names a real function (or a new one to create), its file, the change, and a "done when" check an executor can verify. Vague tasks ("improve X") are not allowed — read the code and make them concrete.
- **Line limits.** The master plan ≤ 250 lines. When an area's detail exceeds ~40 lines, move the file/function breakdown to `areas/<area-id>-<slug>.md` beside the master plan (each ≤ 250 lines) and keep only the area heading, summary, status, and link in the master plan.
- **Resolve overlaps.** When two plans touch the same file or function: consolidate into one task list, prefer the newer plan's intent, and mark the older plan `superseded` in INDEX.md's Plan Registry with a note of what replaced it. Genuine conflicts you cannot resolve get a `⚠ CONFLICT` line in the area for a human to decide.
- **Idempotent and non-destructive.** Preserve existing IDs, statuses, ticks, and manual edits on re-runs; only add, update statuses, or restructure what actually changed. **Never delete or rewrite the source plan files** — they are the inputs, not the output.
- **Close the loop with the index.** After writing PLAN.md, update INDEX.md's Plan Registry (`Consolidated into` column) and Function Index rows so every task ID appears in both, then verify both files are within their line limits.

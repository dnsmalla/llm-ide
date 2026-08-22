---
name: plan-director
description: Use when plans have piled up unlinked in the plans directory, when a collected plan needs consolidating into the master plan, or when a project needs a first master plan derived from code alone. Maintains one hierarchical, line-limited master plan with stable task IDs.
---

# Plan Director

## Overview

Plans accumulate one at a time, each for a specific piece of work, with no links between them. This skill is the director: it reads them, resolves overlaps, and maintains **one** hierarchical master plan (default `llm-doc/plans/PLAN.md`) so the project's whole intent is visible in a single indexed document.

**Announce at start:** "I'm using the plan-director skill to consolidate the plans."

## When to use

- After new plans land in the input directory; when the master plan is missing or stale; to bootstrap a first plan from code alone.
- NOT for writing an individual feature plan (`writing-plans`) and NOT for refreshing the index alone (`plan-structure-index`).

## Inputs and roots

- Resolve the project root, `Input:`/`Write output to:` overrides, defaults, and the `docs/plans/` fallback **exactly as plan-structure-index's "Locating the roots" section defines** — one authority, so the two skills can never resolve the same project to different trees.
- Read the structure index (the file the Structure Index stage's Output names; default `INDEX.md` beside the input plans). It is **stale** when missing or when its frontmatter `commit` ≠ current repo HEAD — then run `plan-structure-index` first.
- Read only the plans that need it: those with no Plan Registry row, or changed since the index's `updated`. Trust the registry rows for already-consolidated, unchanged plans.
- Read code only for the files you are writing or updating tasks for; for everything else trust the File/Function Index rows and `git diff --name-only <INDEX commit>..HEAD`.

## Master plan contract

Frontmatter: `updated` (ISO date) and `commit` (short repo HEAD). Then:

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

Bootstrap-derived areas replace the status in the heading with `status: proposed` until a human accepts them (then normal `n/m` counting resumes). The **checkboxes are the single source of truth for done-ness**; the area `n/m` counter and the Function Index `Status` column are derived from them.

## Rules

- **Stable IDs, never renumbered.** `A<n>` areas, `A<n>.F<m>` file plans, `A<n>.F<m>.<k>` function tasks. New items append; completed tasks keep their `[x]` rows. These task IDs live in the Function Index's `Plan task` column — never in its `F<n>` `ID` column, which is the index skill's own namespace.
- **Function tasks are the unit** — concrete, to the same bar as `writing-plans`' "No Placeholders" rule: a real function, its file, the change, and an observable `Done when:` check.
- **Line limits.** Master plan and each area file ≤ 250 lines; when an area's detail exceeds ~40 lines, move the breakdown to `areas/<area-id>-<slug>.md` beside the master plan and keep heading + summary + status + link. The index's own limit (300) is the index skill's rule — satisfy it by moving detail here, never by deleting index rows. Verify with `wc -l`, not by re-reading.
- **Resolve overlaps.** Two plans touching the same file/function: consolidate into one task list, prefer the newer intent, mark the older plan `superseded` in the Plan Registry. Unresolvable conflicts get a `⚠ CONFLICT` line for a human.
- **Idempotent and non-destructive.** Preserve existing IDs, ticks, and human edits; never delete or rewrite the source plan files.
- **Close the loop — cells only.** After writing the master plan, update the index's plan-derived cells (`Plans`, `Plan task`, `Status`, `Consolidated into`) for the task IDs you added or changed this run. Never restructure or regenerate the index's tables — plan-structure-index owns their shape and code-derived columns.

## Bootstrapping from code (no plans collected yet)

1. Start from the code-derived index: its `⚠ refactor candidate` rows, `proposed` Function Index rows, entry points, and folder purposes.
2. Gather signals cheaply — `grep -rn 'TODO\|FIXME\|HACK'`, `wc -l`, the index's rows — for: oversized files, duplicated logic, untested modules, layering violations, dead code, doc gaps.
3. Write the normal master-plan structure from the top ~15 candidates, one area per theme, each area marked `status: proposed`. Fully read a file **only** when writing its tasks, so every task names real functions with real evidence.

## Grounding future plans

The index and master plan are the standing context for every plan written later: start a new plan from them (reuse file purposes and function IDs; check for an area that already covers or conflicts with the work), then land it **in the input directory** so the next run consolidates it. Note: `writing-plans` saves to `docs/superpowers/plans/` by default — either point the Loop stage's Input there, or save/copy the plan into the loop's input directory; the director only ever consolidates its input directory.

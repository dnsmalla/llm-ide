---
name: plan-structure-index
description: Use when plans need a current structure index — before consolidating plans, after files or folders changed, or when the plans directory has no INDEX.md yet. Maintains the folder/file/function indexes and plan registry that ground all planning.
---

# Plan Structure Index

## Overview

Maintain the plan structure index (default `llm-doc/plans/INDEX.md`): the fast lookup that grounds all planning — which folders and files matter, which functions each plan changes, and which plan files exist. Zero plans is not a failure: with an empty input directory, build the index from the code itself; that code-derived index is what the `plan-director` skill's bootstrap mode and every later plan start from.

**Announce at start:** "I'm using the plan-structure-index skill to refresh the plan index."

## When to use

- Before running or re-running the plan director; when files/folders changed since the index's `commit`; when a new plan landed in the input directory; when no INDEX.md exists yet.
- NOT for documentation indexes (the `documentation` skill owns the docs index) and NOT for writing plans (that is `writing-plans` / `plan-director`).

## Locating the roots (the authority — plan-director defers to this section)

1. **Supplied paths win.** The task message may carry `Input: <dir>` (plans directory) and `Write output to: <file>` (index file) — they override every default below.
2. **Resolving a relative path**: try it against the **repo (git) root first** — the Loop's path picker stores paths relative to it — then against the **project root**; use whichever exists (for a new output file, whichever parent directory exists).
3. **Project root** = the directory containing `system/project.json`: the repo root itself, or two levels up when the repo is checked out under `code/`.
4. **Defaults** (nothing supplied): input `<project root>/llm-doc/plans/`, output `INDEX.md` inside it. Create the directory if missing.
5. **Fallback** (no `system/project.json` found at either candidate root): `docs/plans/` in the repo, index file `docs/plans/INDEX.md`. This same predicate governs plan-director.

## INDEX.md contract

Frontmatter: `updated` (ISO date) and `commit` (short repo HEAD). Then, in order:

### 1. `## Folder Structure Index`
Annotated tree, 2–3 levels: `path/ — purpose`. Exclude generated/vendored trees (`node_modules`, `.build`, `dist`, `.git`, `system/`, `graphify-out/`, caches). Cover the areas plans touch plus top-level orientation.

### 2. `## File Index`
| Path | Purpose | Lines | Plans |

Files covered by active plans plus key entry points; flag files over 500 lines with `⚠ refactor candidate` (this is the one place that threshold is defined). `Plans` lists master-plan task IDs, `—` when none. **With no plans yet**: every entry point, each area's key module, and the 20 largest files over the threshold.

### 3. `## Function Index`
| ID | Function | File:Line | Plan task | Status |

`ID` is `F1`, `F2`, … — a **function-row namespace of its own**, never renumbered or reused, and never confused with master-plan task IDs (`A1.F1.1`), which belong **only** in the `Plan task` column. `Status` ∈ `proposed / planned / in-progress / done`; it is derived from the master plan's checkboxes, which are the single source of truth for done-ness. **With no plans yet**: seed from the public functions of key modules and the functions of the top 20 refactor candidates — extract signatures with grep, do not read file bodies — status `proposed`, `Plan task` `—`.

### 4. `## Plan Registry`
| File | Title | Status | Consolidated into |

One row per file in the input directory, excluding the index file, the master plan (whatever name the director's Output gives it), and `areas/`. `Status` ∈ `active / done / superseded`; `Consolidated into` names the master-plan area, `—` if not yet.

## Update rules

- **Diff against the `commit` baseline**: run `git diff --name-status <frontmatter commit>..HEAD`. Empty and no new/changed plan files → change nothing (or only `updated`). Otherwise recompute only the sections whose paths appear in the diff; skip the folder tree unless a directory was added or removed.
- **Column ownership**: the plan-derived cells — `Plans`, `Plan task`, `Status`, `Consolidated into` — are written by the plan director. Preserve them verbatim when rewriting code-derived cells; never treat them as drift.
- **Line limit**: keep the index under 300 lines by collapsing to what plans touch — but never by deleting history: done/removed items keep their rows (marked), and stable IDs survive.
- Never modify plan files from this skill — the index only reads them.

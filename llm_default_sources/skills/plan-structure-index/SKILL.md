---
name: plan-structure-index
description: Refresh the plan structure index (llm-doc/plans/INDEX.md) — folder, file, and function indexes plus a registry of every plan — so planning stays fast, clear, and current with the real code structure
---

# Plan Structure Index

## Overview

Maintain `llm-doc/plans/INDEX.md`: the single fast lookup that makes every plan navigable — which folders and files the plans touch, which functions each plan changes, and which plan files exist. Run it whenever the file or folder structure has changed since the index was last written, or when a new plan lands in `llm-doc/plans/`.

**Zero plans is not a failure.** When the input directory is empty or missing, build the index from the code itself — the codebase is the source of truth, and the code-derived index is exactly what grounds the first plans (see the `plan-director` skill's bootstrap mode) and every plan written later.

**Announce at start:** "I'm using the plan-structure-index skill to refresh the plan index."

## Locating the roots

- **Honor supplied paths first.** The task message may carry `Input: <dir>` (the plans directory to read) and `Write output to: <file>` (the index file) — these come from the Loop stage's editable Input/Output fields and **override every default below**.
- **Project root** = the directory containing `system/project.json`. That is the current repo root itself, or — in the clone-into-code layout — two levels up from the repo (`<project>/code/<repo>` → `<project>`). Relative Input/Output paths resolve against it.
- **Defaults** (when no Input/Output is supplied): input `<project root>/llm-doc/plans/`, output `<project root>/llm-doc/plans/INDEX.md`. Create the directory if missing.
- **Fallback** (no `system/project.json` anywhere above): use `docs/plans/INDEX.md` in the repo.

## INDEX.md contract

Start the file with frontmatter:

```yaml
---
updated: <ISO date>
commit: <short hash of the code repo HEAD, if resolvable>
---
```

Then exactly these sections, in order:

### 1. `## Folder Structure Index`
An annotated tree of the codebase, 2–3 levels deep, one line per directory: `path/ — purpose`. Exclude generated/vendored trees (`node_modules`, `.build`, `dist`, `.git`, `system/`, `graphify-out/`, caches). Keep it to the areas plans actually touch plus top-level orientation.

### 2. `## File Index`
A table of the files covered by active plans plus key entry points:

| Path | Purpose | Lines | Plans |
|---|---|---|---|

`Lines` is the file's current line count; flag any file over 500 lines with `⚠ refactor candidate`. `Plans` lists the plan task IDs (from PLAN.md) that touch the file — `—` when none yet.

**With no plans yet**, select the files from the code: every entry point, the key module of each area, every file over 500 lines, and the most-imported files — the professional map a planner needs to start from.

### 3. `## Function Index`
The per-function tracking table:

| ID | Function | File:Line | Plan task | Status |
|---|---|---|---|---|

IDs are `F1`, `F2`, … — **stable**: never renumber or reuse an ID. `Status` ∈ `proposed / planned / in-progress / done`.

**With no plans yet**, seed it from the code: the public functions of each key module and every function inside a refactor candidate (oversized file, duplicated logic, deep nesting), with `Plan task` `—` and status `proposed`. These rows are what the plan director turns into its first tasks.

### 4. `## Plan Registry`
One row per file in `llm-doc/plans/` (excluding `INDEX.md`, `PLAN.md`, and `areas/`):

| File | Title | Status | Consolidated into |
|---|---|---|---|

`Status` ∈ `active / done / superseded`. `Consolidated into` names the PLAN.md area (e.g. `A2`) that absorbed it, or `—` if not yet consolidated.

## Update rules

- **Diff first, rewrite least.** Compare each section against the real tree/files and rewrite only the sections that drifted. If nothing drifted, change only the `updated` frontmatter — or nothing at all.
- **Line limit:** keep INDEX.md under 300 lines by collapsing the folder tree and file table to what the plans touch; orientation entries stay one line.
- **Never delete history:** a done function or plan keeps its row with status `done`; a removed file's row is marked, not dropped, until its plan tasks are closed.
- Do not modify any plan file from this skill — the index only reads them.

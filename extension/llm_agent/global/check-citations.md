---
name: check-citations
kind: read
description: Check a plan or answer you are about to present — reports every cited file that does not exist, every `path:line` past the end of its file, and every code symbol the project's code graph does not know. Call it on the full document before presenting a plan.
schema:
  text:
    type: string
    required: true
    maxLength: 200000
    description: The full document to check, exactly as you will present it (markdown; citations are the backticked paths, `path:line` references and code symbols in it).
---

# check-citations

Validates the citations in a document against the project on disk and its code
graph, so a plan never sends Execute to a file, line or function that does not
exist.

## What it checks

- Backticked **paths** (`src/app/view.ts`) — the file must exist in the open
  workspace or an indexed repo.
- Backticked **`path:line`** or **`path:start-end`** — the line must be inside the file.
- Backticked **calls** (`rotatePin()`, `Store.save()`) and **PascalCase type
  names** (`ChatEngine`) — the name must exist in the code graph for the repo
  you are working in. Properties, locals and dotted names without `()`
  (`activeProject`, `Store.save`) are not checked. Skipped
  (`graphChecked: false`) when no repo-scoped graph exists.

## How to use it

Call it once with the whole document before you present it.

- `lineOutOfRange`: fix every entry — look the right line up with `find-code`.
- `missingPaths`: EXPECTED for files the plan will create. Keep those and mark
  them as new in the plan (e.g. "create `src/x.ts`"); fix only paths that were
  meant to already exist. Bare filenames without a `/` are not checked.
- `unknownSymbols`: not found in this repo's code graph. The graph may lag
  recent edits, so an unknown name is a prompt to verify with `find-code`,
  not proof it is wrong; library and builtin names are expected here.

`ok: true` means nothing it could check was wrong. It returns only names and
numbers, never file contents.

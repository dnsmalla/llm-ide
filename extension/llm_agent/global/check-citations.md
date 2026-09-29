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
- Backticked **code symbols** (`rotatePin()`, `Store.save`, `snake_case`) — the
  name must exist in the code graph for the repo you are working in. Skipped
  (`graphChecked: false`) when no repo-scoped graph exists.

## How to use it

Call it once with the whole document before you present it. Fix or remove every
entry in `missingPaths`, `lineOutOfRange` and `unknownSymbols` — look the right
name or line up with `find-code` — then present the corrected document. `ok:
true` means nothing it could check was wrong. It returns only names and
numbers, never file contents.

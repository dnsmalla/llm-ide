---
name: find-code
kind: read
description: Search the project's code index and graph for a symbol, file, or feature — returns definition sites with file:line, graph-related code (callers, callees, importers), and full-text hits. Use this before any grep.
schema:
  query:
    type: string
    required: true
    maxLength: 256
    description: A symbol name, filename, feature, or error string to locate in the user's indexed code (e.g. "FileDetailView", "handleCodeAssist", "line numbers gutter").
  limit:
    type: number
    required: false
    description: Max results per section (1-20, default 8).
  hops:
    type: number
    required: false
    description: How far to walk the code graph from each match (0-2, default 1). Use 0 for a pure "where is this defined" lookup, 2 to widen a blast-radius check.
---

# find-code

Find code by searching the project's **code index and graph** — the symbol index
(every function/class with its `file:line`), the relationship graph (who calls,
imports, or declares it), and the full-text index of file contents.

## When to use

**This is the FIRST tool for any question about code in the user's project** —
"why is X wrong", "where is Y handled", "what breaks if I change Z", "review the
gutter rendering". One call gives you the definition site, the related code, and
text hits; you then read only the lines that matter.

Do NOT open with `run-bash grep`/`find` to locate code. That costs one full turn
per guess and drags whole files into context. Call `find-code` first, then read
the specific paths and lines it returns. Fall back to grep only when `find-code`
comes back empty and its `hint` says the project has no index.

Use `list-files` when you want a directory listing rather than a search, and
`search-kb` for meetings/decisions/tickets — not code.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "find-code", "arguments": {"query": "FileDetailView line numbers"}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{
  "query": "FileDetailView line numbers",
  "symbols": [
    { "name": "FileDetailView", "kind": "classType", "path": "mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift", "line": 24 }
  ],
  "related": [
    { "name": "CodeWebView", "kind": "classType", "path": "mac/Sources/LlmIdeMac/Views/Library/CodeWebView.swift", "line": 12, "relation": "calls" },
    { "name": "LibraryView", "kind": "classType", "path": "mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift", "line": 88, "relation": "called by" }
  ],
  "files": [
    { "path": "mac/Sources/LlmIdeMac/Views/Library/CodeWebView.swift", "excerpt": "…lineNumbers.append(String(idx + 1))…" }
  ],
  "hint": "Read only the ranges you need: …"
}
```

- **`symbols`** — direct index matches, best first. `path` + `line` is the
  definition site: quote it as `path:line`.
- **`related`** — graph neighbours, each with the `relation` that connects it:
  `calls`, `called by`, `imports`, `imported by`, `declares` (a file's symbols),
  `declared in`, `references`, `implements`, `inherits from`. `called by` /
  `imported by` are what tell you the blast radius of a change.
- **`files`** — full-text hits, for matches the symbol graph can't hold
  (comments, string literals, error messages) or repos with no graph yet.
- **`unverifiedPath: true`** on an entry means the index has that path but it
  isn't on disk in the current workspace (a stale index, or a different clone) —
  confirm with `list-files` before quoting it as fact.
- **`outsideWorkspace: true`** means the path resolved in another indexed repo,
  not the folder the user has open. `run-bash` runs in the workspace, so a
  relative `sed -n` on it will NOT read that file — use `read-file` instead, and
  say which repo it came from rather than implying it's their open project.
- **`hint`** — what to do next. On an empty result it says whether the query
  missed or the project simply has no index.

## After a hit

Read narrowly. You have the line number, so fetch the surrounding lines
(`run-bash` with `sed -n '20,80p' <path>`) rather than `read-file` on a large
file. Returned paths are relative to the user's workspace root, which is exactly
`run-bash`'s working directory, so pass them through unchanged — do not prepend a
repo name or absolute prefix. The one exception is an entry flagged
`outsideWorkspace`: that file lives in a different indexed repo, so reach it with
`read-file` rather than a relative shell command.

Follow `related` entries instead of re-searching: they are already the answer to
"what else touches this".

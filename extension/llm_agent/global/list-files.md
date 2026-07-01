---
name: list-files
kind: read
schema:
  subdir:
    type: string
    required: false
    maxLength: 512
    description: Optional repo-relative subdirectory to scope the listing to (e.g. "docs", "extension/core").
  query:
    type: string
    required: false
    maxLength: 256
    description: Optional case-insensitive substring filter on the relative path (e.g. "readme", ".swift").
---

# list-files

List files in the project the user has open (and their indexed repos), so you
can discover what exists before reading anything.

## When to use

The user refers to a file in their project ("the README", "the config", "that
test") and you need to find its path, or you want to see the project's layout.
Use this instead of guessing a path. Reads are scoped to the open workspace and
indexed repos — never the wider disk.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "list-files", "arguments": {"query": "readme"}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{ "files": ["README.md", "docs/guide.md"], "truncated": false }
```

`files` are repo-relative paths. `truncated` is true when the listing hit its
cap — narrow it with `subdir` or `query`. Read a file's contents with
`read-file`. Secret files (.env, .ssh, keys) and heavy dirs (node_modules, .git)
are excluded.

---
name: read-file
kind: read
schema:
  path:
    type: string
    required: true
    minLength: 1
    maxLength: 1024
    description: Repo-relative (preferred) or absolute path to a text file in the open workspace or an indexed repo, e.g. "README.md" or "extension/core/logger.mjs".
---

# read-file

Read the text contents of a file in the project the user has open (or an indexed
repo) so you can review, explain, or reference it.

## When to use

The user asks you to review/explain/check a file that exists in their project
("review the README", "what does logger.mjs do"). Find the path with
`list-files` first if you're unsure. This is read-only — to CHANGE a file, the
user must attach it and you propose an `update-file`.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "read-file", "arguments": {"path": "README.md"}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{ "path": "README.md", "content": "# LLM IDE\n...", "truncated": false, "bytes": 1843 }
```

`content` is the file's UTF-8 text (truncated past ~200 KB, flagged by
`truncated`). On a denied/missing path you get `{ "error": "..." }` — the path
is outside the readable scope (open workspace + indexed repos), is a secret
file, or doesn't exist. Don't retry the same path; list-files to find the right
one, or ask the user to attach it.

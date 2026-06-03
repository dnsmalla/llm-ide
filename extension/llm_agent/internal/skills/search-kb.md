---
name: search-kb
kind: read
schema:
  query:
    type: string
    required: true
    maxLength: 200
    description: terse keyword query, e.g. "sidebar icons decision"
---

# search-kb

Search the user's meetings, notes, decisions, and indexed code chunks
through the knowledge-base full-text index.

## When to use

The user asks about something they have discussed before, or you need
prior context to answer well. Always prefer a search over guessing.

## Call shape

<<<TOOL_CALL>>>
{"name": "search-kb", "arguments": {"query": "<keywords>"}}
<<<END_TOOL_CALL>>>

## Result shape

The server returns inside `<<<TOOL_RESULT>>>` an object:

```
{
  "hits": [
    {"kind": "meeting" | "decision" | "action" | "source", "id": "...", "title": "...", "snippet": "..."},
    ...
  ],
  "truncated": false
}
```

`hits` is at most 10 entries, ordered by FTS5 relevance. `truncated` is
`true` when more matches exist beyond the cap.

## Examples

- User: "What did we decide about sidebar icons?"
  → query: "sidebar icons decision"
- User: "Did anyone bring up colour palettes?"
  → query: "colour palette"
- User: "Find the function that handles caption deduplication"
  → query: "caption deduplication"

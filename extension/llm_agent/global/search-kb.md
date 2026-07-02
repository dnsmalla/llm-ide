---
name: search-kb
kind: read
schema:
  query:
    type: string
    required: true
    maxLength: 256
    description: Free-text search over the user's knowledge base (meeting transcripts, decisions, action items, connected sources).
---

# search-kb

Search the user's knowledge base — meeting transcripts, decisions, action
items, and connected sources — by free text.

## When to use

The user references something discussed or decided outside the code ("what
did we decide about the auth flow?", "when is the deploy planned?", "what
did the client ask for?"). Code questions should use list-files/read-file
instead; this searches MEETING/PLANNING knowledge, not file contents.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "search-kb", "arguments": {"query": "auth token rotation decision"}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{ "hits": [{ "kind": "meeting", "id": "m_123", "title": "Sprint planning", "snippet": "…rotate refresh tokens on use…" }], "truncated": false }
```

Up to 10 hits. `truncated` true means more matches exist — refine the query.

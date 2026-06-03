---
name: ask-internal
kind: read
schema:
  question:
    type: string
    required: true
    maxLength: 500
    description: one-sentence question or instruction for the internal agent
---

# ask-internal

Delegate to the Meet Notes internal agent — the only authority on
this app's state.

## When to use

The user references this app's data or surfaces (see global prompt
for the full list). Do not call for general engineering questions.

## Call shape

<<<TOOL_CALL>>>
{"name": "ask-internal", "arguments": {"question": "..."}}
<<<END_TOOL_CALL>>>

## Result shape

{"answer": "<internal's natural-language response>", "pendingTool": null | {...}}

When `pendingTool` is non-null, surface it as-is — the client
handles confirmation.

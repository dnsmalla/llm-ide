---
name: project_memory
kind: read
schema:
  focus:
    type: string
    required: false
    maxLength: 256
    description: Optional topic to prioritize when selecting which memory to include; defaults to the current user message.
---

# project_memory

Retrieve this project's accumulated memory — durable, auto-generated facts,
decisions, and Q&A distilled from past sessions in this repo/workspace.

## When to use

Call this when grounded project-specific context (past decisions, known
issues, prior answers) would improve the answer, instead of guessing.
Returns a short note if no project memory has been generated yet for this
workspace.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "project_memory", "arguments": {"focus": "auth token rotation"}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{ "text": "## Project memory\n- decided to rotate refresh tokens on use\n…" }
```

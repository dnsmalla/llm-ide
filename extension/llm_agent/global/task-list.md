---
name: task-list
kind: read
schema: {}
---

# task-list

Return your current task list for this session.

## When to use

Call this to check which tasks are pending, in-progress, or done. Use it at the start of a continuation turn to decide what to work on next.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "task-list", "arguments": {}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{
  "tasks": [
    { "id": "1", "title": "Scaffold the new route", "status": "completed" },
    { "id": "2", "title": "Write tests for the route", "status": "in_progress" },
    { "id": "3", "title": "Update the docs", "status": "pending" }
  ]
}
```

Status values: `pending`, `in_progress`, `completed`, `skipped`.

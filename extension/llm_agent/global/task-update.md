---
name: task-update
kind: read
schema:
  taskId:
    type: string
    required: true
    description: The task id returned by task-create or task-list
  status:
    type: string
    required: false
    enum: [pending, in_progress, completed, skipped]
    description: New status for the task
  title:
    type: string
    required: false
    maxLength: 200
    description: Rename the task (optional)
---

# task-update

Update a task's status or title.

## When to use

- Mark a task `in_progress` when you start it.
- Mark it `completed` when you finish it.
- Mark it `skipped` if it turns out not to be needed.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "task-update", "arguments": {"taskId": "2", "status": "completed"}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{ "id": "2", "title": "Write tests for the route", "status": "completed" }
```

On error: `{ "error": "no task with id '99'" }`

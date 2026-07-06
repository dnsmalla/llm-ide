---
name: task-create
kind: read
schema:
  title:
    type: string
    required: true
    minLength: 1
    maxLength: 200
    description: Short imperative description of the task (e.g. "Add error handling to the auth route")
---

# task-create

Add a new task to your session task list.

## When to use

At the start of a multi-step job, call this once per task to build out your plan. You can also add tasks mid-work when you discover new work.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "task-create", "arguments": {"title": "Add error handling to the auth route"}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{ "id": "3", "title": "Add error handling to the auth route", "status": "pending" }
```

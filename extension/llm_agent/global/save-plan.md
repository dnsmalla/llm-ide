---
name: save-plan
kind: write
confirmation: editable-sheet
schema:
  title:
    type: string
    required: true
    maxLength: 200
    description: short title for the plan (used to derive the filename, e.g. "Add dark mode support").
  content:
    type: string
    required: true
    maxLength: 200000
    description: the full plan, as markdown, exactly as you want it saved. NOT a diff — the complete document.
---

# save-plan

Save the plan you just proposed as a Markdown file in the open
project, under `llm-doc/plans/`. The Mac client picks the exact
filename (from today's date + `title`) and saves it immediately, with
no confirmation step — this tool takes no `path` argument, so it can
never write anywhere else, and it always writes to that one
plan-specific location, so it's safe to fire automatically.

This is the ONLY write action available in PLAN mode. Do not attempt
`update-file`, `bash`, or any other write tool here — they are not
available in this mode.

## When to use

Call this after every plan you propose in this mode — right after your
prose plan, in the same turn. It saves right away with no confirmation
from the user, so treat it as committed the moment you call it — don't
call it for a rough draft you're still revising, and mention in your
reply that you've saved it (and where) so the user knows.

## Call shape

<<<TOOL_CALL>>>
{"name": "save-plan", "arguments": {
  "title": "Add dark mode support",
  "content": "# Add Dark Mode Support\n\n**Goal:** ...\n\n## Steps\n\n1. ...\n"
}}
<<<END_TOOL_CALL>>>

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

This is the ONLY write action available in the plan-like modes (PLAN,
ASSIST_PLAN). Do not attempt `update-file`, `bash`, or any other write
tool there — they are not available. Wherever the skill you are
following says to write a file to a path, or to commit, use this
instead.

## When to use

Only for a document that is FINISHED and that the user has approved.
The plan-like modes run a multi-turn process (see the skill and mode
bindings in your prompt): questions first, then a design the user
signs off on, then the written plan. A save on any earlier turn writes
a draft the user never agreed to.

It saves right away with no confirmation, so treat it as committed the
moment you call it — never call it for a draft you are still revising,
and always say in your reply that you saved it and where.

Two documents can legitimately be saved across one planning session:
the design/spec the user approved, and the implementation plan written
from it. Give them distinct titles (ending "Design" and "Plan") — a
second save with the SAME title on the same day overwrites the first
file rather than adding one.

## Call shape

<<<TOOL_CALL>>>
{"name": "save-plan", "arguments": {
  "title": "Add dark mode support",
  "content": "# Add Dark Mode Support\n\n**Goal:** ...\n\n## Steps\n\n1. ...\n"
}}
<<<END_TOOL_CALL>>>

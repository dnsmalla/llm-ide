---
name: update-file
kind: write
confirmation: editable-sheet
schema:
  path:
    type: string
    required: true
    maxLength: 1000
    description: absolute file path of the attached file you want to update. MUST exactly match the path of one of the files the user has attached to this chat — the Mac client refuses any other path.
  content:
    type: string
    required: true
    maxLength: 200000
    description: full replacement content for the file. NOT a diff — emit the entire file as you want it to end up.
---

# update-file

Propose a file-level edit to one of the files the user has attached to
this chat. The Mac client shows the user a diff between the current
file and your proposed content. The user clicks Apply (or edits the
diff) and the Mac writes the file to disk.

## When to use

The user explicitly asks to rewrite, refactor, expand, summarise,
format, or otherwise edit an attached file. Examples:
- "make this README more readable"
- "add a section about LLMs to this file"
- "convert this Python script to use async"
- "add type hints"

Do NOT use for:
- Files NOT attached to this chat — they live in the user's repo and
  need the Review Code workflow (`trigger-review-code`) which spawns
  the CLI in the repo cwd.
- Creating new files — only edits to attached files are supported.
- Changes that span multiple files — emit a separate tool call per
  file (the agent loop allows several).

## Call shape

<<<TOOL_CALL>>>
{"name": "update-file", "arguments": {
  "path": "/Users/.../README.md",
  "content": "# Meet Notes\n\n...the full updated file content here...\n"
}}
<<<END_TOOL_CALL>>>

## Examples

- User: "make this README more readable"
  → path: "<exact path from the attachment chip>"
    content: "<entire rewritten markdown, preserving structure>"

- User: "add a type hint to the foo function in this file"
  → path: "<exact path>"
    content: "<entire file with the type hint added>"

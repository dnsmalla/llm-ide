---
name: update-file
kind: write
confirmation: editable-sheet
schema:
  path:
    type: string
    required: true
    maxLength: 1000
    description: the file to edit. Either the exact path of a file attached to this chat, OR a path inside the active project — workspace-relative ("extension/server.mjs", exactly as find-code returns it) or absolute under the project root. The Mac client refuses any path that is neither attached nor inside the project.
  old_text:
    type: string
    required: false
    maxLength: 60000
    description: the exact text to replace, copied VERBATIM from the current file including every space of indentation. Must occur EXACTLY once in the file — include surrounding lines until it is unique. This is the shape to use for any file you have not seen in full.
  new_text:
    type: string
    required: false
    maxLength: 60000
    description: the text that replaces old_text. Required whenever old_text is given. Pass an empty string to delete the old_text block.
  content:
    type: string
    required: false
    maxLength: 200000
    description: FULL replacement content for the whole file. Only legal when the entire file is in front of you (i.e. the user attached it and it was not truncated). NOT a diff — the entire file as you want it to end up.
---

# update-file

Propose an edit to a real file on disk. The Mac client resolves the
path, computes the resulting content, and shows the user the change
with **Apply**, **Review diff**, and **Skip**. On Apply the Mac writes
the file. In Bypass (auto-edit) mode it applies without asking.

This is how you change code. If you have worked out a fix, emit this
tool — do not paste the patch into your reply and leave the user to
copy it by hand.

## Two shapes — pick by how much of the file you have seen

**Anchored edit (`old_text` + `new_text`) — the default.** Use this for
any file you found yourself with `find-code` / `run-bash` / `read-file`
and read only part of. It rewrites just the matched region, so the rest
of the file cannot be lost.

**Whole-file (`content`).** Only when the complete file is in your
context because the user attached it AND it was not truncated. Emit the
entire file, not a diff.

Never guess `content` for a file you only saw an excerpt of — that
replaces the file with your excerpt and destroys everything you did not
see. When in doubt, use `old_text` / `new_text`.

## Rules for `old_text`

- Copy it verbatim from what you actually read, including indentation.
  A single wrong space means no match and the edit is rejected.
- It must match **exactly once**. If the snippet appears more than once,
  widen it with adjacent lines until it is unique — the client refuses
  an ambiguous match rather than guessing which one you meant.
- Keep it tight: the smallest unique region around the change, not the
  whole function, and never the whole file.
- One region per call. For several regions in one file, or several
  files, emit one call, let the user apply it, then emit the next.

## When to use

The user wants a file on disk changed: fix this bug, refactor this,
add a section, rename this, apply that suggestion.

Do NOT use for:
- Creating new files — only edits to existing files are supported.
- A whole-repo change spanning many files, or work that needs a branch
  and an MR — that is the Review Code workflow
  (`trigger-review-code`), which runs the CLI in the repo.

## Call shape

Anchored edit — a file you located yourself:

<<<TOOL_CALL>>>
{"name": "update-file", "arguments": {
  "path": "mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift",
  "old_text": "            line-height: 1.6;\n",
  "new_text": "            line-height: var(--row);\n"
}}
<<<END_TOOL_CALL>>>

Whole-file — an attached file you can see in full:

<<<TOOL_CALL>>>
{"name": "update-file", "arguments": {
  "path": "/Users/.../README.md",
  "content": "# LLM-IDE\n\n...the full updated file content here...\n"
}}
<<<END_TOOL_CALL>>>

## Examples

- User: "fix that misalignment" (you found the file with find-code and
  read 40 lines of it)
  → path: "<workspace-relative path from find-code>"
    old_text: "<the exact lines you read that need to change>"
    new_text: "<those lines, corrected>"

- User: "make this README more readable" (README attached)
  → path: "<exact path from the attachment chip>"
    content: "<entire rewritten markdown, preserving structure>"

- User: "drop that dead helper" (found via find-code)
  → path: "<workspace-relative path>"
    old_text: "<the whole helper, uniquely anchored>"
    new_text: ""

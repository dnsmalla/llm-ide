---
name: comment-gitlab-issue
kind: write
confirmation: editable-sheet
schema:
  iid:
    type: number
    required: true
    description: issue iid as shown in the System context, e.g. 42
  body:
    type: string
    required: true
    maxLength: 50000
    description: markdown comment body
---

# comment-gitlab-issue

Propose a comment on an EXISTING GitLab issue in the user's active
project. The user reviews the comment body in an editable sheet
before anything is posted.

## When to use

The user asks to comment on / add to / reply to an existing issue
(e.g. "add it to the comment of issue #1", "reply to #42 with…",
"leave a note on the colourful icons issue"). The issue's iid MUST
be visible in the System context block — pick it from there. For
brand-new issues that don't yet exist, use `create-gitlab-issue`
instead.

If the System context says `Active project: (none configured)`,
do not call this tool. Tell the user to add a project in Settings →
GitLab.

## Call shape

<<<TOOL_CALL>>>
{"name": "comment-gitlab-issue", "arguments": {
  "iid": 1,
  "body": "Confirmed on Safari 17.4 — login still fails after clearing cookies."
}}
<<<END_TOOL_CALL>>>

## Examples

- User: "Add a comment to issue #1 saying we should also colour the toolbar."
  → iid: 1
    body: "We should also colour the toolbar to match the sidebar icons."

- User: "Reply to the colourful icons issue: I've started a branch for this."
  → iid: <iid of that issue, looked up from System context>
    body: "I've started a branch for this — will open an MR shortly."

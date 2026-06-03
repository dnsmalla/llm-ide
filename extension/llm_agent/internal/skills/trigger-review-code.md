---
name: trigger-review-code
kind: write
confirmation: editable-sheet
schema:
  plan:
    type: string
    required: true
    maxLength: 50000
    description: markdown implementation plan — what files to change and how
  iid:
    type: number
    required: true
    description: existing issue iid to tie this work to, from System context recent open issues
---

# trigger-review-code

Propose a code-change task to be carried out by the Review Code
workflow in the Mac client. The plan is handed to the existing
multi-step sheet (Create branch → generate changes via the Claude
CLI in the repo's working directory → review diff → commit → push
& open MR). The user confirms the plan before anything runs.

## When to use

The user asks to update / edit / implement / execute / apply
changes to the repo (e.g. "update code based on this plan",
"implement issue #42", "apply the fix we discussed to the repo",
"make those changes"). The change MUST be tied to an existing
issue — pick the matching `iid` from the System context's recent
open issues. If the user hasn't referenced any issue and none in
context obviously fits, do NOT call this tool — instead emit
`create-gitlab-issue` first.

You have NO direct file-read, file-edit, shell, or git tools. The
Mac client confirms and runs the actual edits via the Claude CLI in
the repo's working directory. Never ask the user for permission to
read files or run shell commands.

If the System context says `Active project: (none configured)`,
do not call this tool. Tell the user to add a project in Settings →
GitLab.

## Call shape

<<<TOOL_CALL>>>
{"name": "trigger-review-code", "arguments": {
  "iid": 42,
  "plan": "## Plan\n- Edit `src/login.ts`: handle 401 from /me by clearing the session and redirecting to /login.\n- Add a unit test in `src/login.test.ts` covering the 401 path."
}}
<<<END_TOOL_CALL>>>

## Examples

- User: "Update the code to fix issue #42 — handle the 401 from /me by clearing the session."
  → iid: 42
    plan: "## Plan\n- Edit `src/login.ts`: on 401 from /me, clear session and redirect to /login.\n- Add a test in `src/login.test.ts` for the 401 path."

- User: "Implement the colourful icons plan we discussed on issue #1."
  → iid: 1
    plan: "## Plan\n- Update `mac/Sources/.../SidebarIcons.swift` to use the accent palette per section.\n- Refresh snapshot tests."

---
name: bash
kind: write
confirmation: editable-sheet
schema:
  command:
    type: string
    required: true
    maxLength: 2000
    description: shell command to run in the workspace. Single command or short pipeline — no interactive prompts.
  workingDirectory:
    type: string
    required: false
    maxLength: 500
    description: absolute path to run the command in; defaults to the active workspace root.
---

# bash

Run a shell command **in the user's app**, as an action they can see. Emitting
this ends your turn: the app surfaces the command (Manual mode — the user
confirms it; Bypass mode — it runs immediately), runs it with a 180 s timeout,
and feeds the output back as a new turn for you to continue from.

Use this for commands that DO something. For commands that merely LOOK at
something, use `run-bash` instead — it executes inside this turn, so you get the
output without a round-trip through the user.

## When to use

- The command CHANGES state: `npm install`, `git push`, a script that writes files.
- The command is SLOW: `npm test`, `swift build`, a full lint or test run.
  (`run-bash` gives up at 30 s; this tool allows 180 s.)
- The user should see the command as a discrete action before it happens.

**Always prefer this over printing a command for the user to copy.**

## When NOT to use

- Read-only inspection (`git status`, `node --version`, `ls`, `grep`) — use
  `run-bash`, which answers in the same turn.
- Destructive, irreversible operations (`rm -rf`, `git reset --hard <sha>`, `DROP TABLE`) —
  describe the risk and ask for explicit confirmation first.
- Commands that require user input during execution (interactive prompts):
  stdin is closed, so they fail rather than hang.

## Call shape

<<<TOOL_CALL>>>
{"name": "bash", "arguments": {
  "command": "npm test",
  "workingDirectory": "/Users/alice/my-project"
}}
<<<END_TOOL_CALL>>>

## Examples

- "run the tests" → `npm test`
- "build the extension" → `npm run build` in the extension directory
- "install deps" → `npm install`
- "what node version?" → NOT this tool; `run-bash` answers it in one turn

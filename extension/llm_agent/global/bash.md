---
name: bash
kind: write
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

Run a shell command in the user's workspace. The client executes the
command immediately and feeds the output back into the conversation.

## When to use

- The user asks you to run, execute, or test something.
- You need command output to answer a question (`node --version`, `npm test`, `git status`).
- A build, lint, install, or script step is the action the user requested.

**Always prefer this tool over printing a command for the user to copy.**

## When NOT to use

- Destructive, irreversible operations (`rm -rf`, `git reset --hard <sha>`, `DROP TABLE`) —
  describe the risk and ask for explicit confirmation first.
- Commands that require user input during execution (interactive prompts).

## Call shape

<<<TOOL_CALL>>>
{"name": "bash", "arguments": {
  "command": "npm test",
  "workingDirectory": "/Users/alice/my-project"
}}
<<<END_TOOL_CALL>>>

## Examples

- "run the tests" → `npm test`
- "what node version?" → `node --version`
- "build the extension" → `npm run build` in the extension directory
- "install deps" → `npm install`

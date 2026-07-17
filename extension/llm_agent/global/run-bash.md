---
name: run-bash
kind: read
schema:
  command:
    type: string
    required: true
    maxLength: 2000
    description: shell command to execute. Single command or short pipeline — no interactive input.
  cwd:
    type: string
    required: false
    maxLength: 500
    description: working directory; defaults to the active workspace root.
  timeout:
    type: number
    required: false
    description: timeout in milliseconds (default 30000, max 120000).
---

# run-bash

Execute a shell command in the user's workspace and return its output.

## When to use

- User asks to run a script, build, test, lint, or any shell command.
- You need to inspect output to answer a question (e.g. `node --version`, `npm test`).
- Running a command is the action the user requested — NOT just showing them how.

## When NOT to use

- Destructive operations (`rm -rf`, `drop table`, `git reset --hard`) — confirm with the user first.
- Commands requiring user input (interactive prompts).
- Long-running daemons — use `npm run server &` style only if the user explicitly asks.

## Call shape

<<<TOOL_CALL>>>
{"name": "run-bash", "arguments": {
  "command": "npm test",
  "cwd": "/Users/alice/my-project"
}}
<<<END_TOOL_CALL>>>

## Examples

- User: "run the tests"
  → command: "npm test"

- User: "what node version is this?"
  → command: "node --version"

- User: "build the extension"
  → command: "npm run build", cwd: "<workspace>/extension"

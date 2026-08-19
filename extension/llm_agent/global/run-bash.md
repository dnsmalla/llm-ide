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

Execute a **read-only** shell command in the user's workspace and get its output
back inside this same turn. Keep it to commands that only LOOK at things — for
anything that changes state or takes real time, use `bash`, which surfaces as an
action in the app.

**Safety gate.** Every command is classified before it runs:

- A small allowlist of plainly read-only commands (`git status`/`diff`/`log`,
  `ls`, `cat`, `grep`/`rg`, test runners) runs immediately with no interruption.
- Genuinely destructive commands (`sudo`, `mkfs`, `rm -rf /`, raw device writes)
  are **refused outright** — you cannot run them, and asking again will not help.
- **Everything else is handed to the user for approval and may be denied.** That
  includes any command containing shell control syntax (`;`, `&&`, `||`, `|`,
  `&`, redirects, backticks, `$(…)`) — a pipeline is never auto-approved, even
  when it starts with an allowlisted command. Expect the turn to pause while the
  user decides, and expect a plain "not approved" result back if they decline.

So prefer ONE simple command per call: it is more likely to run without
interrupting the user, and a denial costs you the whole turn.

Because the output arrives immediately, this is the right tool for
investigation: chain several reads in one turn, then answer.

## When to use

- Inspecting repo or environment state: `git status`, `git log`, `git diff`,
  `ls`, `cat`, `grep`, `which`, `node --version`.
- Any quick check whose output you need in order to answer the question.

## When NOT to use

- Commands that CHANGE state (`npm install`, `git push`, scripts that write
  files) or that are SLOW (`npm test`, `swift build`) — use `bash`. It gets a
  180 s budget and surfaces as an action in the app; this tool times out at 30 s
  and, for anything outside the read-only allowlist, still costs the user an
  approval prompt.
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

- User: "what node version is this?"
  → command: "node --version"

- User: "what's changed on this branch?"
  → command: "git status --porcelain=v1"

- User: "run the tests" / "build the extension"
  → NOT this tool: slow and state-changing, so use `bash`.

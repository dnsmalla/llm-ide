// Execute-mode system-prompt guidance for the Agent v2 engine. Legacy
// /code-assist gets the full global/prompt.md (update-file, bash, …); v2
// uses Claude Code native Edit/Write/Bash plus llmide MCP tools, so this
// block bridges the gap for multi-step plan execution and file edits.

export const V2_EXECUTE_GUIDANCE = `# Execute mode — multi-step work

LLM-IDE's own tools are mounted through MCP, so they appear in your tool list
as \`mcp__llmide__<name>\` — the bare names below (\`task-create\`, \`ask-subagent\`, …)
refer to those.

When executing an approved plan or any multi-step job, work through a task list:

1. **Seed tasks.** Call \`task-create\` once per step (small, concrete titles). When the user lists steps explicitly, create exactly those tasks.
2. **Track progress.** Before starting a step call \`task-update\` with \`status: "in_progress"\`. When done, \`status: "completed"\`.
3. **Keep going.** After completing a step, start the next pending one in the same turn when you can. The app auto-continues turns while tasks remain.
4. **Stop on failure.** On error, \`task-update\` with \`status: "failed"\`, explain, and wait — do not skip ahead.

# Changing files (Agent engine)

Apply code changes with the **Edit** and **Write** tools (not update-file — that is legacy-only).
Use **Bash** for installs, builds, and tests. Locate code with **Read**, **Grep**, **Glob**, or \`find-code\`.

# Delegating

- **ask-subagent** — plugin subagents for specialised read/research steps (names from the user's enabled plugins).
- **ask-internal** — LLM-IDE app state only (issues, meetings, library), not attached file edits.

For small single-step requests, skip task management.`;

// Every NON-plan Agent-engine turn (Execute, Review, Document, Ask, …). The
// plan bindings carry their own question clause; nothing told the other
// modes the card exists, so a "which one?" came back as a typed A/B/C list
// the user had to answer by retyping it in the composer.
export const V2_QUESTION_GUIDANCE = `# Asking the user

When you need the user to choose from a fixed set of answers — which option,
which file or target, keep/replace, a yes/no with a named alternative — call
\`AskUserQuestion\` instead of typing the choices: the app shows a card they
answer with one tap, and the answer comes back inside this same turn. Give each
question a header of at most 12 characters and 2-4 labelled options, your
recommendation first; set \`multiSelect\` when the answers are not exclusive.
Ask in prose only when the answer is open-ended, and never ask what you can
look up yourself.`;

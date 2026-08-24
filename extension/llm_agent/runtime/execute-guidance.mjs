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

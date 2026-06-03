---
title: How to add an agent skill
applies_to: server, extension, mac
---

# How to add an agent skill

## Goal

Teach the internal Meet Notes agent a new capability — either a read (server-executed) or a write (client-confirmed).

> The **global** agent has only one skill (`ask-internal`). Don't add skills there — they'd defeat the token-savings goal. All app-aware capabilities live on internal.

## Steps

### 1. Pick a name and a kind

- Name: kebab-case, must match the filename. Example: `get-issue`.
- Kind: `read` (server executes inside the internal loop) or `write` (internal halts; the Mac client renders a confirm sheet).

### 2. Drop a markdown file under `extension/llm_agent/internal/skills/`

Frontmatter:

```yaml
---
name: <kebab-case-name>
kind: read | write
schema:
  <argname>:
    type: string | number | boolean | string[]
    required: true | false
    maxLength: <int>           # for strings only
    description: <one-liner>
confirmation: editable-sheet   # required for kind: write
---
```

Body: `# <name>`, `## When to use`, `## Call shape`, `## Result shape` (read only), `## Examples` (2–4).

### 3. Server side

- **Read tool:** create a handler module under `extension/llm_agent/runtime/handlers/<name>.mjs` exporting a single function `(args, ctx) => Promise<result>`. Wire it into the handlers map at the top of `extension/llm_agent/runtime/handlers/ask-internal.mjs` — that's where internal's handler set is built.
- **Write tool:** no server code needed — internal's loop returns the validated arguments as `pendingTool` and the Mac client decides what to do.

### 4. Mac client side (write tools only)

Add a confirm sheet under `mac/Sources/MeetNotesMac/Agent/Views/` modelled on `CreateGitLabIssueSheet.swift`. Wire it from `CodeAssistantPanel.swift` keyed on `pendingTool.name`.

### 5. Restart and test

The server caches skill files at boot. Restart from Settings → Backend. Then ask the Code Assistant something that should trigger the new skill via the global → internal hop.

## Verification

- Server logs `[llm_agent] internal warnings:` if your frontmatter doesn't parse. Fix and restart.
- Internal should call the new skill instead of asking the user for parameters that are already in its `# System context` block.
- Global should delegate to internal (via `ask-internal`) for any request that mentions the new capability's domain.

## See also

- [Agent tools — design and history](../explanation/agent-tools.md)
- [ADR 0011 — Fence convention over native tool_use](../decisions/0011-fence-convention-over-cli.md)
- [ADR 0012 — Global + internal agent split](../decisions/0012-global-internal-agent-split.md)

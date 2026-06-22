---
title: How to add an agent skill
applies_to: server, extension, mac
---

# How to add an agent skill

## Goal

Teach the internal LLM IDE agent a new capability — either a read (server-executed) or a write (client-confirmed).

> **Tool definitions are authored centrally, not here.** The `.md` files in
> `extension/llm_agent/internal/skills/` (domain tools) and the managed `.md` defs in
> `extension/llm_agent/global/` (always-on tools) are **mirrors** of the
> [`dnsmalla/skills`](https://github.com/dnsmalla/skills) repo (`agent-tools/` and
> `agent-globals/` families). The `skills-drift` CI fails if they diverge from the commit
> pinned in `extension/.skills-lock`, and `npm run sync:skills` re-mirrors them with
> `rsync --delete`. So **editing a def directly here will be reverted** — author it in
> central, then sync. The **handlers** (the code a `read`/`write` tool runs) stay local and
> are resolved by name; only the definition is central.

## Steps

### 1. Pick a name and a kind

- Name: kebab-case, must match the filename. Example: `get-issue`.
- Kind: `read` (server executes inside the internal loop) or `write` (internal halts; the Mac client renders a confirm sheet).

### 2. Author the definition in the central skills repo

In a checkout of [`dnsmalla/skills`](https://github.com/dnsmalla/skills), add the `.md` file to the family that matches:

- **`agent-tools/`** — domain tools (e.g. `create-gitlab-issue`). These mirror into this app's `internal/skills/`.
- **`agent-globals/`** — the always-on agent-loop primitives (`ask-internal`, `ask-subagent`, `update-file`). Add here only for a genuinely always-on capability; domain work belongs in `agent-tools/`.

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

Central CI (`validate.sh`) enforces this frontmatter shape — the same rules this app's loader applies — so a malformed def fails there instead of being silently dropped at load time here. Commit and push to central.

### 3. Mirror the def into this repo

```bash
cd extension && npm run sync:skills
```

This pulls `agent-tools/` → `internal/skills/` and `agent-globals/` (the `.md` defs) → `global/`, then records the synced central commit in `extension/.skills-lock`. Commit the changed def(s) **and** the updated `.skills-lock` — the `skills-drift` workflow checks them against that pin. (Source resolution: `$SKILLS_REPO`, then `~/skills`, then a cached clone — see `scripts/sync-skills.sh`.)

### 4. Server side — the handler (stays local)

- **Read tool:** create a handler module under `extension/llm_agent/runtime/handlers/<name>.mjs` exporting a single function `(args, ctx) => Promise<result>`. Wire it into the handlers map at the top of `extension/llm_agent/runtime/handlers/ask-internal.mjs` — that's where internal's handler set is built.
- **Write tool:** no server code needed — internal's loop returns the validated arguments as `pendingTool` and the Mac client decides what to do.

### 5. Mac client side (write tools only)

Add a confirm sheet under `mac/Sources/LlmIdeMac/Agent/Views/` modelled on `CreateGitLabIssueSheet.swift`. Wire it from `CodeAssistantPanel.swift` keyed on `pendingTool.name`.

### 6. Restart and test

The server caches skill files at boot. Restart from Settings → Backend. Then ask the Code Assistant something that should trigger the new skill via the global → internal hop.

## Verification

- Server logs `[llm_agent] internal warnings:` if your frontmatter doesn't parse. Fix in central, re-sync, restart.
- `npm run sync:skills` followed by `git status` should show no unexpected changes (the def matches central); the `skills-drift` CI enforces this on every push.
- Internal should call the new skill instead of asking the user for parameters that are already in its `# System context` block.
- Global should delegate to internal (via `ask-internal`) for any request that mentions the new capability's domain.

## Not this flow: process/design/domain *plugin* skills

The handler-bound tools above are one of two skill families this system consumes from central. The other — the process/design/domain **prompt skills** (brainstorming, TDD, code-review, …) — are not handler-bound and are delivered through the **Claude Code plugin bridge**, not this sync. They are toggleable per user rather than always-on. The bridge is implemented in
`extension/plugins/claude-adapter.mjs` and the `/auth/me/claude-plugins/*` endpoints. Note it
imports from the local `~/.claude/plugins` cache, so it requires Claude Code installed on the
box with the `dnsmalla/skills` marketplace added — it does not fetch from git directly.

## See also

- [Agent tools — design and history](../explanation/agent-tools.md)
- [ADR 0011 — Fence convention over native tool_use](../decisions/0011-fence-convention-over-cli.md)
- [ADR 0012 — Global + internal agent split](../decisions/0012-global-internal-agent-split.md)

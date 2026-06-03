---
title: Code Assistant agent — tool calls + agent-skill files
status: accepted
audience: internal
date: 2026-05-19
---

# Code Assistant agent — tool calls + agent-skill files

## Context

Today's Code Assistant (the "Claude" pane on the right of every Mac view) is a stateless chat with no awareness of the user's actual environment. When the user asks "create an issue to make sidebar icons colourful," the agent answers with three clarifying questions — *which tracker? which project? which labels?* — because every fact about the system is hidden from it. The system prompt is generic; the only context comes from attached files.

The result is that the agent feels like a stranger inside an app that already knows everything it's being asked. Every productive interaction starts with the user re-typing facts the app could have told it.

This spec gives the agent two new capabilities:

1. **Pre-attached context** about the user's environment (active GitLab project, indexed code repositories) on every request, so the agent stops asking obvious questions.
2. **A small, growable set of tools** the agent can invoke to act: search the knowledge base, file a GitLab issue (with a user-editable confirm step). Tools are described to the agent as markdown skill files committed to the repo — adding a new capability later is mostly a markdown drop, not a code change.

## Goals

- Eliminate the most common "agent asks for context it should already have" failure mode.
- Let the agent file a GitLab issue without the user copy-pasting into a separate dialog.
- Keep the server stateless. Every `/code-assist` request carries the full state needed to serve it.
- Keep the surface area small enough to ship in one phase.
- Make adding a future capability (open PR, dispatch agent run, comment on issue) primarily a markdown change, with one handler entry per new write tool.
- Degrade gracefully when prerequisites are missing — no active GitLab project, no indexed repos, malformed agent output, hit iteration cap.

## Non-goals

- Streaming tokens during the tool loop. The user sees the final reply when the loop exits.
- Multiple write tools in a single agent turn.
- Other writers (open PR, comment on issue, dispatch agent run, modify Library).
- User-installable agent skills at runtime (`~/.meetnotes/agent-skills/`).
- Per-user skill enable/disable toggles.
- Persisting a pending tool call across an app relaunch.
- Anthropic API tool_use native protocol — we stay on the `claude -p` CLI shell-out and use a fence convention. Migrating to the native protocol is a future option, not in scope.

## Audience

The Mac engineer and the server engineer working in the same repo. Phase-1 read-only docs for the eventual third-party reader.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Agent can both *know* and *act*, with confirm on writes | Matches the user's actual phrasing ("can you create an issue…") |
| D2 | Tools in scope: `search-kb` (read), `create-gitlab-issue` (write) | Smallest set that unblocks the most common ask |
| D3 | `get-active-project` and `list-indexed-repos` demoted from tools to embedded prompt context | They're already-known client state; no tool round needed |
| D4 | Server-side tool loop using a fence convention over `claude -p` (no Anthropic API key required) | The user does not always have an API key in the vault; the CLI path is the always-available baseline |
| D5 | Write tools execute client-side, after an editable confirm sheet | The Mac already has the GitLab token in Keychain; keeps the server stateless and the sheet UX simple |
| D6 | Read tools execute server-side; result is fed back to the agent as a `<<<TOOL_RESULT>>>` block inside the next loop iteration | Read tools need DB access (KB FTS5); server owns the DB |
| D7 | Agent capabilities described as markdown files under `extension/agent-skills/*.md`, loaded into the system prompt at request time | New capability = mostly a markdown drop; lowers the bar for follow-up phases |
| D8 | Iteration cap = 5 tool rounds per user turn | Protects against runaway loops while leaving headroom for one search + one write workflow |
| D9 | History wire shape unchanged: `[{role, content}]` array of strings | Avoids churning every client of `/code-assist`; tool calls / results live inside the assistant turn's content |
| D10 | Confirm UX: editable modal sheet with title / description / labels / assignee, project read-only | Issue titles will sometimes be wrong; cheaper to edit than to cancel-and-retry |

## Architecture

```
┌─ Mac (Code Assistant) ──────────────────────────────────────────┐
│  1. user types message                                          │
│  2. attach agentContext { activeProject, indexedRepos }         │
│  3. POST /code-assist  { message, history, attachments,         │
│                          agentContext }                         │
└────────────┬────────────────────────────────────────────────────┘
             ▼
┌─ /code-assist (extension/server/ai-routes.mjs) ─────────────────┐
│  Build system prompt:                                           │
│    base instructions (agent-skills/_base.md)                    │
│    + agentContext block                                         │
│    + every agent-skills/*.md (cached at boot)                   │
│  Loop (≤ 5 iterations):                                         │
│    runClaude(prompt)                                            │
│    parse one TOOL_CALL fence                                    │
│    ─ read tool: execute server-side, append TOOL_RESULT,        │
│                  re-prompt, loop                                │
│    ─ write tool: stop loop, return as pendingTool               │
│    ─ plain text: return as reply                                │
│    ─ malformed / unknown: append error TOOL_RESULT, loop        │
└────────────┬────────────────────────────────────────────────────┘
             ▼
┌─ Mac (response render) ─────────────────────────────────────────┐
│  Render reply markdown.                                         │
│  If pendingTool present → editable sheet on click.              │
│  On confirm:                                                    │
│    Mac calls GitLab directly with edited args                   │
│    Replaces card with "✓ Filed #42" + link                      │
│    Appends synthetic user turn to history, re-POSTs /code-assist│
│    with empty `message`. Agent acknowledges.                    │
└─────────────────────────────────────────────────────────────────┘
```

## Embedded context block

Built by the Mac client, sent in the request body as `agentContext`, inlined into the system prompt by the server. Rebuilt on every request — no caching — so Settings changes are picked up instantly.

```text
# System context

## Active GitLab project
- Name: notes-extension
- URL: https://gitlab.com/grid-devs/personal/dinesh/notes-extension
- Default branch: main

## Indexed code repositories (from the user's Library)
- notes-extension     (path: ~/Developer/MeetNotes/notes-extension)
```

When fields are empty, the block still renders with explicit `(none configured)` markers so the agent can give the user a useful pointer rather than fall apart silently.

**Source-of-truth on the Mac side:**
- `activeProject` ← `config.gitLabSavedProjects.first(where: \.isActive)`
- `indexedRepos` ← `LibraryItemStore.items(for: .code)` grouped by `folderOrigin`

## Agent-skill files

Skill files live under `extension/agent-skills/`. The server reads every `*.md` at boot, parses frontmatter, caches the body, and rebuilds the system prompt for each request.

### Frontmatter

```yaml
---
name: <kebab-case-identifier>       # required, must match fence.name
kind: read | write                  # required; drives where it executes
schema:                             # required (may be empty for no-arg tools)
  <arg>:
    type: string | number | boolean | string[]
    required: true | false
    maxLength: <int>                # for string types
    description: <one-liner>
confirmation: editable-sheet        # required for kind: write
---
```

### Body

A short markdown document with these sections, all required:

- `# <name>` — the skill's title, matches the frontmatter `name` but human-readable
- `## When to use` — guidance for the agent on when this skill is the right move
- `## Call shape` — the exact fence the agent must emit, with a placeholder example
- `## Result shape` — for `kind: read` only — the JSON the agent will see in the `TOOL_RESULT` block
- `## Examples` — 2–4 sample user questions and the call the agent should emit

### Bundled skills (Phase 1)

**`extension/agent-skills/_base.md`** — global rules, prepended to every prompt:

- The agent's role and tone.
- The fence convention (`<<<TOOL_CALL>>>` / `<<<END_TOOL_CALL>>>`, one per turn).
- The instruction to prefer a tool call over a clarifying question when the user's intent maps to a tool.
- The instruction to never narrate "I could call X" — either call it, or do not mention it.
- The rule that the agent must respect `(none configured)` markers in the context block.

**`extension/agent-skills/search-kb.md`** — `kind: read`. Single string argument `query` (≤ 200 chars). Result: `{hits: [{kind, title, snippet}], truncated}`.

**`extension/agent-skills/create-gitlab-issue.md`** — `kind: write`, `confirmation: editable-sheet`. Arguments:

| Arg | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | 1–200 chars |
| `description` | string | yes | ≤ 50 000 chars, markdown |
| `labels` | `string[]` | no | e.g. `["enhancement", "ui"]` |
| `assignee` | string | no | GitLab username, no `@` prefix |

### Prompt assembly

```js
// Pseudocode for the server-side composer.
function buildSystemPrompt(agentContext) {
  const base       = readFile('agent-skills/_base.md');
  const contextMd  = formatAgentContext(agentContext);
  const skillFiles = glob('agent-skills/*.md').filter(notBase);
  const skillBodies = skillFiles.map(readFile).join('\n\n---\n\n');
  return `${base}\n\n${contextMd}\n\n# Available skills\n\n${skillBodies}`;
}
```

Validation:

- Frontmatter is parsed at boot. Invalid YAML → log warning, drop the skill.
- Tool calls are validated against the cached schema before execution. Type mismatch / missing required arg → feed `{"error": "Missing 'query' argument"}` back as a `TOOL_RESULT`, count against the iteration cap.
- Unknown `fence.name` → same path, with `{"error": "Unknown tool: foo"}`.

## Fence convention

The agent emits exactly one of these between fences when it wants a tool:

```text
<<<TOOL_CALL>>>
{"name": "search-kb", "arguments": {"query": "sidebar icons colourful"}}
<<<END_TOOL_CALL>>>
```

- One tool per turn. The parser stops at the first fence pair.
- Anything outside the fence is treated as freeform prose that streams to the user as the assistant's reply.
- Malformed JSON / unknown tool / schema violation → error path, loop continues.

Server feeds tool results back to the agent inside:

```text
<<<TOOL_RESULT>>>
{"hits": [...], "truncated": false}
<<<END_TOOL_RESULT>>>
```

## Server execution loop

Pseudo-code that lives in `extension/server/ai-routes.mjs`:

```js
async function runCodeAssistTurn(prompt, history, agentContext, userId) {
  let current = prompt;          // initial Claude input (system + history + user)
  let preToolText = "";          // prose to surface to user
  const MAX_ITERATIONS = 5;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const out = await runClaude(current);
    const { text, fence } = parseToolCallFence(out);
    preToolText += text;

    if (!fence) {
      return { reply: preToolText.trim(), pendingTool: null };
    }

    const skill = skills[fence.name];
    if (!skill) {
      current = appendErrorAndRetry(current, out, `Unknown tool: ${fence.name}`);
      continue;
    }

    const validation = validateArgs(skill.schema, fence.arguments);
    if (validation.error) {
      current = appendErrorAndRetry(current, out, validation.error);
      continue;
    }

    if (skill.kind === 'write') {
      return {
        reply: preToolText.trim(),
        pendingTool: { name: fence.name, arguments: validation.value },
      };
    }

    // read tool
    const result = await runReadHandler(skill.name, validation.value, userId);
    current = appendToolResult(current, out, result);
  }

  return {
    reply: preToolText.trim() + "\n\n_(reached the 5-call tool limit — try again)_",
    pendingTool: null,
  };
}
```

`appendErrorAndRetry` and `appendToolResult` rebuild the next prompt as: prior prompt + agent's previous output verbatim + `<<<TOOL_RESULT>>>{json}<<<END_TOOL_RESULT>>>`. The agent sees its own last turn and the result/error, so it can adapt.

**Read-handler dispatch** is keyed by skill name. Phase-1 handlers:

| Skill | Handler |
|---|---|
| `search-kb` | Reuses the same code path as `/kb/search` — runs FTS5 against the user's tenant, returns top 10 hits with `{kind, title, snippet}`. |

## Client confirm flow (write tool)

1. `/code-assist` response arrives with `pendingTool`. Mac renders the assistant bubble:
   - Markdown prose (from `reply`).
   - A **pending-action card** below it: lock icon, header `Will create issue:`, title in bold, first ~200 chars of description, label chips, project name read-only. Tap → opens the **editable sheet**.

2. The editable sheet contains:
   - **Title** — `TextField`, required, ≤ 200 chars.
   - **Description** — multi-line `TextEditor`, monospace.
   - **Labels** — chip-style editor (existing component if available, otherwise a simple comma-separated `TextField`).
   - **Assignee** — `TextField` with `@` prefix, optional.
   - **Project** — read-only label showing the active project's name and URL. Tip text underneath: "Change in Settings → GitLab".
   - **Cancel** and **Create issue** buttons.

3. **Create issue:**
   - Mac calls GitLab via the existing client (token loaded from Keychain by `GitLabClient`). Endpoint: `POST /projects/<id>/issues`.
   - On success: pending card is replaced with `✓ Filed issue #42` and the issue URL is rendered as a markdown link.
   - The Mac appends a synthetic user turn to history: `(executed create-gitlab-issue → #42 https://gitlab.com/…/issues/42)`. The agent's next reply acknowledges in natural language. The follow-up `/code-assist` request sends `message: ""` to avoid double-prompting the user.
   - On 4xx/5xx from GitLab: sheet stays open, inline red error below the buttons, no history append. User can retry or cancel.

4. **Cancel:** card dismissed, no history append, nothing fired. The next chat turn proceeds without any record of the proposed action.

## History wire shape

Unchanged from today. The `history` array on the wire is `[{role: "user"|"assistant", content: string}]`. Tool calls appear inside the assistant's `content` string (literal `<<<TOOL_CALL>>>…<<<END_TOOL_CALL>>>` fences). Tool results are not stored in history — they live transiently inside the server's loop and never reach the client.

The synthetic user turn after a confirmed write is also just a `{role: "user", content: "(executed …)"}` entry. No special-cased role or content type.

## Failure modes

| Mode | Behaviour |
|---|---|
| Agent emits no fence in a turn that should have used a tool | Treated as plain chat. Same as today. |
| Agent emits malformed JSON in the fence | Error fed back as `TOOL_RESULT`. Counts toward iteration cap. |
| Agent emits an unknown tool name | Error fed back. Same path. |
| Required argument missing or schema-violating | Error fed back. Same path. |
| Iteration cap of 5 reached | Server returns `reply` with `_(reached the 5-call tool limit — try again)_` appended. `pendingTool: null`. |
| Server-side read handler throws | Error string fed back as `TOOL_RESULT`. Agent sees it and can either retry, ask the user, or give up gracefully. |
| `agentContext.activeProject` is empty when the agent calls `create-gitlab-issue` | Agent is instructed (via `_base.md`) to tell the user to configure one in Settings → GitLab instead of calling the tool. If it still calls anyway, the Mac client refuses to open the sheet and shows the same hint. |
| Mac client offline during write | The pending card stays visible; clicking Create issue surfaces the network error inline. No retry queue. |
| App killed while a pending card is on-screen | Pending tool is lost. The user can re-ask. |

## Out of scope (explicit)

- Streaming tokens during the loop.
- Multiple write tools per turn.
- Open PR / comment on issue / dispatch agent run / Library mutations.
- User-installable agent skills at runtime.
- Per-user skill enable/disable.
- Persistence of pending tool calls across app launches.
- Migration to Anthropic API native tool_use protocol.

## Implementation phases

The plan is one phase; tasks group into three areas.

**Area 1 — Server (extension/server/ai-routes.mjs + extension/agent-skills/)**

1. Skill loader: glob `agent-skills/*.md` at boot, parse frontmatter, cache.
2. Prompt composer: `buildSystemPrompt(agentContext)`.
3. Fence parser + validator.
4. The 5-iteration loop replacing the current single `runClaude` call in `/code-assist`.
5. Read-handler dispatch table; `search-kb` handler delegating to the existing `/kb/search` code path.
6. Write the three skill files: `_base.md`, `search-kb.md`, `create-gitlab-issue.md`.
7. Tests: skill loader (valid + invalid frontmatter), fence parser (well-formed, malformed, missing fence), loop (read tool, write tool, iteration cap, unknown tool).

**Area 2 — Mac client (Code Assistant + GitLab client)**

1. Add `agentContext` to the `/code-assist` request body. Compose from `AppConfig.gitLabSavedProjects` and `LibraryItemStore`.
2. Extend `CodeAssistResponse` decoder with optional `pendingTool` field.
3. New SwiftUI component: `PendingActionCard` (collapsed view in the chat bubble).
4. New SwiftUI sheet: `CreateGitLabIssueSheet` with editable title / description / labels / assignee.
5. Wire the Confirm path to the existing `GitLabClient` (extend it if `createIssue` isn't already there).
6. After a successful confirm, append the synthetic user turn and POST `/code-assist` with `message: ""`.
7. Tests: response decoding (pendingTool present vs absent), sheet form validation, GitLab error rendering.

**Area 3 — Documentation**

1. New how-to: `docs/how-to/add-an-agent-skill.md` — "drop a markdown file under `extension/agent-skills/`, add a handler if it's a write tool, restart the server, you're done."
2. New explanation: `docs/explanation/agent-tools.md` — the same architectural diagram + the fence convention so a future contributor doesn't have to re-derive it from code.
3. New ADR: `docs/decisions/NNNN-fence-convention-over-cli.md` — locks in the choice of fence-over-CLI vs Anthropic API tool_use.

## Success criteria

- User types "create issue: make sidebar icons colourful" → agent produces a pending card with a sensible title and description, *without* asking which project. The card opens to an editable sheet; clicking Create issue files the issue under the active GitLab project and the bubble updates to `✓ Filed #N`.
- User types "what did we say about colour palettes last week?" → agent calls `search-kb` once, receives the hits, answers with a synthesis (no clarifying question about which meeting).
- A new agent capability can be added with:
  - **Read tool:** one `.md` file under `extension/agent-skills/` plus one entry in the server-side read-handler dispatch table.
  - **Write tool:** one `.md` file plus one new SwiftUI confirm sheet on the Mac side (the server-side dispatch path is shared — it returns the validated `pendingTool` and the Mac decides how to render it based on `confirmation:` frontmatter).
- `extension` test suite remains green. New tests cover the loop, the fence parser, and the skill loader.
- The Mac app still works when the user has no Anthropic API key in the vault — the fence path is the always-available baseline.

## Open questions

None at design time. Implementation may surface specific subtleties (assignee username resolution, label autocomplete in the sheet, exact wording of the `_base.md` rules). Those will be addressed during implementation.

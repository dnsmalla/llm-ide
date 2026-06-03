---
title: Agent tools — design and history
status: stable
---

# Agent tools — design and history

> Why the Code Assistant has the shape it does. For the day-to-day "how do I add a new tool" recipe, see [how-to/add-an-agent-skill.md](../how-to/add-an-agent-skill.md).

## Architecture

The Code Assistant is two agents sharing one engine:

- **Global** — the front-line agent. Lean prompt: a role description and exactly one tool (`ask-internal`). Handles general engineering questions directly using its own knowledge. Delegates anything app-specific to internal.
- **Internal** — the system-aware specialist. Receives the full `agentContext` snapshot (active GitLab project, indexed code repos, recent open issues, recent meetings, app capabilities) plus the action skills (`search-kb`, `create-gitlab-issue`, `comment-gitlab-issue`, `trigger-review-code`). Returns prose or a `pendingTool` to global.

```
Mac client ── POST /code-assist ──▶ extension/server/ai-routes.mjs
                                            │
                                            ▼
                                   llm_agent/runtime/route.mjs
                                            │
                                            ▼
                              llm_agent/runtime/loop.mjs (global)
                                            │
                       ┌────────────────────┴────────────────────┐
                       ▼                                         ▼
              plain reply                               fence: ask-internal
                       │                                         │
                       │              ▼                          ▼
                       │   handlers/ask-internal.mjs ─▶ loop.mjs (internal)
                       │                                          │
                       │                       ┌──────────────────┴──────────────────┐
                       │                       ▼                                     ▼
                       │              search-kb (server)        create-gitlab-issue / comment-gitlab-issue / trigger-review-code
                       │                       │                                     │
                       │                       ▼                                     ▼
                       │              tool result fed back            pendingTool propagated
                       │                       │                                     │
                       │                       ▼                                     │
                       │              internal answers in prose                      │
                       │                       │                                     │
                       │                       ▼                                     │
                       └─────── {answer, pendingTool} returned to global ◀───────────┘
                                            │
                                            ▼
                                   Mac client receives {reply, pendingTool}
```

## Why two agents

The first Code Assistant carried the full system context — capabilities, project, repos, issues, meetings — on every prompt. As we added more pre-loaded context, every general engineering question started paying for ~3.5 K tokens of unused state.

The split keeps the front door lean. Pure general turns are ~85% cheaper. System-related turns pay the same as before (the full context still loads, just on internal's side). Architectural separation between mechanism (`runtime/`) and content (`global/`, `internal/`) makes the system easier to extend.

## Why fence convention over native tool_use

The `claude -p` CLI is the always-available baseline ([ADR 0001](../decisions/0001-claude-cli-not-api-key.md)). It returns plain text. To express tool calls over plain text, both agents emit `<<<TOOL_CALL>>>{...}<<<END_TOOL_CALL>>>`. The parser tolerates malformed output by feeding the error back inside `<<<TOOL_RESULT>>>` and looping; the agent self-corrects. See [ADR 0011](../decisions/0011-fence-convention-over-cli.md).

## Why client-side confirm

The Mac already has the user's GitLab token in Keychain. Keeping confirm + execute on the Mac means:

- The server stays stateless. No per-session "pending tool" cache.
- The confirm sheet can edit the agent's proposed args freely without a round-trip.
- Future write tools that touch local-only state (Library, settings) need no server work.

When internal emits the `create-gitlab-issue` fence, its loop halts; the `ask-internal` handler propagates the `pendingTool` up to global; global's prompt rule tells it to surface that pendingTool as-is without narrating. The Mac receives the unchanged wire shape and renders the same confirm sheet as today.

## Why skill files instead of inline tool schemas

Two reasons:

1. **Adding a capability is mostly a markdown drop.** Frontmatter + a brief When-to-use + examples — no code change to the system-prompt assembler.
2. **The skill body doubles as the agent's manual.** The same markdown the engineer reads to understand the surface is the markdown the agent reads to learn it.

The cost is one server restart whenever a skill file changes — skills are parsed and cached at boot.

## Iteration caps

- Global: **3** rounds per user turn. One delegation, one final reply, one safety buffer.
- Internal: **5** rounds per delegation (today's value). One search + one write is the realistic ceiling.
- Worst case 15 LLM rounds; practically 2–3.

## See also

- [how-to/add-an-agent-skill.md](../how-to/add-an-agent-skill.md)
- [ADR 0011 — Fence convention over native tool_use](../decisions/0011-fence-convention-over-cli.md)
- [ADR 0012 — Global + internal agent split](../decisions/0012-global-internal-agent-split.md)
- [Engineering invariants — local server](invariants.md#local-server-extensionservermjs)

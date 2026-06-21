---
title: Agent runtime
status: draft
---

# Agent runtime

!!! info "Rebuild-grade detail"
    Exact contracts (loop algorithm, fence protocol, skill schema, sub-model cascade, runClaude, dispatch) are in [`../spec/agent-runtime.md`](../spec/agent-runtime.md).

**Status:** draft
**Related spec:** [`spec/agent-runtime.md`](../spec/agent-runtime.md)
**Related reference:** [`reference/agent-skills.md`](../reference/agent-skills.md)

---

## What it is

The agent runtime is the shared machinery that powers the Code Assistant — the structured iteration engine, the LLM call primitive, and the skill system that lets the assistant act on the user's behalf. It lives under `extension/llm_agent/` and `extension/agents/`.

It is not the meeting agent (that is a separate loop in `extension/agents/meeting-agent.mjs`). The agent runtime specifically drives the interactive `POST /code-assist` code assistant surface.

## Two agents, one engine

The Code Assistant is deliberately split into two agents that share a single iteration engine (`runtime/loop.mjs`):

- **Global** — the front-line agent. Its prompt ([`extension/llm_agent/global/prompt.md`](../../extension/llm_agent/global/prompt.md)) is lean: a role description plus a single delegation skill (`ask-internal`). General engineering questions are answered directly; anything that requires live system state is delegated.
- **Internal** — the system-aware specialist. Its prompt ([`extension/llm_agent/internal/prompt.md`](../../extension/llm_agent/internal/prompt.md)) loads the full `agentContext` snapshot (active GitLab project, indexed code repos, recent issues, recent meetings, app capabilities) plus the action skills. It either answers in prose or emits a write-tool fence to be confirmed on the client.

Both agents run the same `runAgentLoop` function. The split exists because loading the full system context on every request — even pure general engineering questions — is expensive. The front door stays lean; the context cost is paid only when the internal agent is actually delegated to. See [agent-tools.md](agent-tools.md) for the design rationale.

## The depth model

`runAgentLoop` accepts a `depth` parameter that bounds nesting:

- **Depth 0** — global agent. Called directly by the `/code-assist` route handler.
- **Depth 1** — internal agent or plugin subagent. Invoked by `ask-internal` or `ask-subagent` handlers when global delegates a task.
- **Depth 2** — the cap. No further nesting is allowed. The loop throws immediately if a handler would push depth past 2.

In plain terms: user turn → global (depth 0) → internal (depth 1) → result. A third layer of nesting is structurally prevented. This keeps the worst-case LLM call count bounded (global cap: 3 iterations; internal cap: 10 iterations per delegation; practically 2–3 total in typical use).

## Co-pilot stance and the meeting agent

The meeting agent follows the same CLI-based LLM access pattern as the rest of the runtime — every LLM call goes through `runClaude` in `extension/agents/runtime.mjs`, which `execFile`s the local `claude` CLI rather than calling the Anthropic API directly. No Anthropic SDK, no API key in the meeting-agent path.

The co-pilot stance is enforced at the design level: the meeting agent **never auto-types text into the meeting**. When it drafts a question, it appends it to the `/kb/live/:sessionId` stream with `source: "agent-question"`. Both surfaces (Chrome extension side panel, Mac app TranscriptView) render these rows visually distinct — styled with a different color or icon — so the user can read them and choose to ask the question themselves. The agent is invisible to other meeting participants.

Questions surface as `[agent ?]` rows in the transcript; they are never spoken, never sent to the meeting platform, and never injected into the captions the user's microphone produces. See [meeting-agent.md](meeting-agent.md) for the loop logic and confidence gating.

## Skills and prompts

Skills are Markdown files under `extension/llm_agent/`. Frontmatter declares the name, kind (`read` or `write`), and argument schema. The body is both the human-readable description and the agent's in-context manual — the same file serves both purposes.

**Read skills** run server-side: the handler executes, its result is fed back as `<<<TOOL_RESULT>>>`, and the loop continues. **Write skills** cause the loop to exit immediately, returning a `pendingTool` for the client to present in a confirm sheet. No write executes without user confirmation.

The full skill catalog — all global, internal, and plugin skills — is in [`../reference/agent-skills.md`](../reference/agent-skills.md).

Verbatim prompts (the authoritative source; do not rely on paraphrases in docs):

- [`extension/llm_agent/global/prompt.md`](../../extension/llm_agent/global/prompt.md) — global agent role and rules
- [`extension/llm_agent/internal/prompt.md`](../../extension/llm_agent/internal/prompt.md) — internal agent role and rules

## How it fits together

A typical code assistant turn:

1. Mac client POSTs to `/code-assist`.
2. Route handler assembles `agentContext` and calls `runAgentLoop` at depth 0 (global).
3. Global agent decides: answer directly, or emit an `ask-internal` fence.
4. If delegating: `ask-internal` handler calls `runAgentLoop` at depth 1 (internal) with full system context injected.
5. Internal either answers in prose or emits a write-tool fence (e.g. `create-gitlab-issue`).
6. Write fence propagates up through global unchanged; client receives `{ reply, pendingTool }` and shows a confirm sheet.
7. User approves or edits the proposed action on the client side; the server stays stateless.

## See also

- [`spec/agent-runtime.md`](../spec/agent-runtime.md) — rebuild-grade contracts for the loop, fence protocol, skill schema, sub-model cascade, runClaude, and dispatch
- [`reference/agent-skills.md`](../reference/agent-skills.md) — full skill catalog
- [meeting-agent.md](meeting-agent.md) — the meeting co-pilot loop and surface behavior
- [agent-tools.md](agent-tools.md) — why two agents, why fence convention, design history
- [ADR 0001 — Claude CLI, not API key](../decisions/0001-claude-cli-not-api-key.md)
- [ADR 0011 — Fence convention over native tool_use](../decisions/0011-fence-convention-over-cli.md)
- [ADR 0012 — Global + internal agent split](../decisions/0012-global-internal-agent-split.md)

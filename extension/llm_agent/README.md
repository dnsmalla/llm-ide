# llm_agent

All agent runtime for the LLM-IDE Code Assistant lives here. Two
agents share one engine:

- `global/` — the front-line agent. Lean prompt, one tool
  (`ask-internal`). Handles general engineering questions directly,
  delegates anything app-specific to internal.
- `internal/` — the system-aware specialist. Receives the full
  `agentContext` snapshot plus skills (`search-kb`,
  `create-gitlab-issue`). Returns prose or a `pendingTool` to global.

The engine is the Claude Agent SDK (`sdk/`), or the multi-provider
adapter (`adapter/`). Both agents use the same engine, configured with
different prompts and handler sets. Shared mechanism lives beside it:

- `tools/` — tool registry, gates, handlers (`tools/handlers/`), redaction, Jev `decide`.
- `modes/` — mode classification, personas, tier-to-model resolution.
- `memory/` — per-turn memory extraction, persistence and selection.
- `plan/` — the plan pipeline and execute guidance.
- `tasks/` — session-task prompt injection and skill routing.
- `skills/` — skill loader, registry and library.

Mechanism is the folders above. Markdown never lives there; content is
in `global/` and `internal/`. Code never lives there.

Architecture explanation: [`docs/explanation/agent-tools.md`](../../docs/explanation/agent-tools.md)
How to add a skill: [`docs/how-to/add-an-agent-skill.md`](../../docs/how-to/add-an-agent-skill.md)

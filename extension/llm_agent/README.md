# llm_agent

All agent runtime for the Meet Notes Code Assistant lives here. Two
agents share one engine:

- `global/` — the front-line agent. Lean prompt, one tool
  (`ask-internal`). Handles general engineering questions directly,
  delegates anything app-specific to internal.
- `internal/` — the system-aware specialist. Receives the full
  `agentContext` snapshot plus skills (`search-kb`,
  `create-gitlab-issue`). Returns prose or a `pendingTool` to global.

The engine (`runtime/`) is content-agnostic — it parses fences,
validates args against schemas loaded from markdown frontmatter, and
runs an N-iteration loop. Both agents use the same engine, configured
with different prompts and handler sets.

- Mechanism in `runtime/`. Markdown never lives there.
- Content in `global/` and `internal/`. Code never lives there.

Architecture spec: [`docs/superpowers/specs/2026-05-19-global-internal-agent-split-design.md`](../../docs/superpowers/specs/2026-05-19-global-internal-agent-split-design.md)
Architecture explanation: [`docs/explanation/agent-tools.md`](../../docs/explanation/agent-tools.md)
How to add a skill: [`docs/how-to/add-an-agent-skill.md`](../../docs/how-to/add-an-agent-skill.md)

---
title: "0012. Split the Code Assistant into global and internal agents"
status: accepted
date: 2026-05-19
---

# 0012. Split the Code Assistant into global and internal agents

## Context

The monolithic agent (one prompt with role + skills + every context block) was paying the full ~3.5 K-token system-context tax on every turn, including pure general engineering questions that used none of it. As we added more pre-loaded context (recent issues, recent meetings, app capabilities), the tax kept growing.

Two alternative shapes were considered:

1. **Lazy context** — keep one agent, move all pre-loaded context behind tools the agent calls only when needed.
2. **Two-agent split** — a lean front-line agent that delegates to a context-loaded specialist via a single delegation tool.

## Decision

Adopt the two-agent split:

- **Global** owns: the role description, one tool (`ask-internal`), and the user's conversation. Lean prompt.
- **Internal** owns: the system-context block, all action skills (`search-kb`, `create-gitlab-issue`, anything we add later), and stateless answer/action turns.
- One HTTP roundtrip per user message. The server orchestrates the global → (maybe) internal hop internally.
- Internal returns natural-language prose + an optional `pendingTool` to global; global passes either through unchanged.

All agent code lives under `extension/llm_agent/`, with `runtime/` (mechanism), `global/` (lean content), and `internal/` (system-aware content) as the three children.

## Consequences

- **Positive:** pure general turns drop from ~3500 to ~600 prompt tokens.
- **Positive:** adding a new app-aware capability is a single-folder change under `internal/`.
- **Positive:** the regression guard test asserts that global's prompt never contains app-specific context — defends against future "let's just add one more thing to global" creep.
- **Negative:** system-related turns cost ~17% more tokens (the 600-token global wrapper on top of the same ~3500-token internal prompt).
- **Negative:** one extra LLM round per system-related turn (global → internal → global). Latency cost is one Claude CLI invocation.
- **Locked in:** see [explanation/agent-tools.md](../explanation/agent-tools.md). Lazy-context as an alternative was rejected because it adds tool rounds for state the agent will almost always need.

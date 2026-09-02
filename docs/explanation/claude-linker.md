---
title: Claude linker
status: stable
---

# Claude linker

> The two bounded layers — one per side — that own ALL Claude-specific knowledge (Agent SDK, `claude` CLI, model ids, transcript layout). An SDK/CLI update edits these layers and nothing else. Design history: `docs/superpowers/specs/2026-09-02-claude-linker-design.md`.

## The boundary

The Mac↔server wire format (the `/agent/v2/stream` SSE vocabulary, decision bodies, `/code-assist` events) is **ours**, defined by `extension/llm_agent/sdk/events.mjs` and versioned by `SERVER_API_VERSION` — it does not change when the SDK does. The linker is drawn so both endpoints of that vocabulary sit inside linker files:

```
Claude Agent SDK / claude CLI
        │  (only the server linker touches these)
        ▼
┌─ Server linker ──────────────────────────────┐
│ extension/llm_agent/sdk/   SDK engine, event │
│   engine.mjs · events.mjs · tools.mjs ·      │
│   hooks.mjs · decisions.mjs · transcripts.mjs│
│   · spike-engine.mjs                         │
│ extension/providers/       CLI argv builders,│
│   providers.mjs · runtime.mjs ·              │
│   web-client.mjs           stream-json parse │
└──────────────┬───────────────────────────────┘
               │  our wire format (frozen per SERVER_API_VERSION)
               ▼
┌─ Mac linker ─────────────────────────────────┐
│ mac/Sources/LlmIdeMac/ClaudeLink/            │
│   AgentV2Event.swift        wire decode      │
│   AgentV2Transport.swift    request/mapping  │
│   ClaudeToolPresentation.swift  tool names   │
│   ClaudeCLI.swift           CLI flags/models │
└──────────────────────────────────────────────┘
               ▲
   everything else (routes, engines, views)
   consumes linker exports only
```

Enforcement:

- **Server**: ESLint (`extension/eslint.config.mjs`, `CLAUDE_SDK_IMPORT`) rejects any import of `@anthropic-ai/claude-agent-sdk` outside `llm_agent/sdk/` (tests exempt). Zero-violation ratchet, like the layer rules.
- **Mac**: convention — `LlmIdeAPIClient.toolVerb`/`progressLabel`/`normalizedToolName` and `ToolApprovalCard.title`/`icon`/`alwaysAllowLabel` are one-line shims delegating into `ClaudeLink/`; keep new Claude knowledge (tool names, flags, model ids, error codes) inside `ClaudeLink/` files.

## What lives where

| Knowledge | Owner |
|---|---|
| `@anthropic-ai/claude-agent-sdk` import, `query()` options, resume semantics, `canUseTool` | `extension/llm_agent/sdk/engine.mjs` |
| SDK message → wire event mapping | `extension/llm_agent/sdk/events.mjs` |
| SDK transcript disk layout (`CLAUDE_CONFIG_DIR`, `~/.claude/projects/…`) | `extension/llm_agent/sdk/transcripts.mjs` |
| Provider id the SDK engine meters under | `AGENT_SDK_PROVIDER` in `engine.mjs` |
| `claude` CLI argv (`-p`, `--output-format stream-json`, `--mcp-config`, …), stream-json parsing, model-id regex, 500k prompt cap | `extension/providers/providers.mjs` + `runtime.mjs` |
| SDK pin | `extension/package.json` (`@anthropic-ai/claude-agent-sdk`) |
| Wire event decode (Mac) | `ClaudeLink/AgentV2Event.swift` |
| v2 request body, event→result mapping, `SESSION_UNRESUMABLE` handling | `ClaudeLink/AgentV2Transport.swift` (the HTTP/SSE transport itself is generic: `LlmIdeAPIClient+CodeAssist.swift`) |
| Retired Claude model-id migration map | `ClaudeCLI.retiredModelIds` (merged by `AppConfig`) |
| Tool-name → verb/title/icon vocabulary (SDK built-ins + llm-ide tools) | `ClaudeLink/ClaudeToolPresentation.swift` |
| CLI executable, `-p`, `--permission-mode acceptEdits`, fallback model ids, provider id, vault key (Mac) | `ClaudeLink/ClaudeCLI.swift` |

## SDK update playbook

On the next `@anthropic-ai/claude-agent-sdk` (or `claude` CLI) bump, work in this order:

1. **Pin**: bump `extension/package.json`, run `npm install`; `tests/dependency-pins.test.mjs` pins the version.
2. **Server linker**: fix what the new SDK changed —
   `llm_agent/sdk/engine.mjs` (query options, permission modes, resume), `events.mjs` (message shapes — keep the OUTPUT wire format identical; absorb changes here), `tools.mjs`/`hooks.mjs`/`decisions.mjs`, `transcripts.mjs` (disk layout), and for CLI-flag changes `providers/providers.mjs` + `runtime.mjs` + `web-client.mjs`.
3. **Tests**: `cd extension && npm test` — the SDK-shaped suites are `agent-v2-events`, `agent-v2-tools`, `agent-v2-routes`, `agent-sdk-spike`, `providers`, `spawn-cli-stream`, `stream-model-reply`, `mcp-cli-args`, `mcp-runclaude-args`, `cli-concurrency-cap`, `dependency-pins`.
4. **Mac linker — only if the wire had to change** (new event type, new tool name, new approval arg): `ClaudeLink/AgentV2Event.swift`, `ClaudeToolPresentation.swift` (verb/title rows for new tools), `AgentV2Transport.swift`; a renamed CLI flag or model line lands in `ClaudeLink/ClaudeCLI.swift`. Bump `SERVER_API_VERSION` + `BackendManager.minimumServerApiVersion` **only** for a breaking wire change, per the existing lockstep rule.
5. **Verify**: `make test && make test-mac && make lint`, then one live chat turn per engine (v2 + legacy) against a running server.

Anything the update forces you to edit **outside** these files is a boundary leak — move the knowledge into the linker as part of the same change, and extend this page's table.

---
title: Claude linker
status: stable
---

# Claude linker

> The two bounded layers — one per side — that own ALL Claude-specific knowledge (Agent SDK, `claude` CLI, model ids, transcript layout). An SDK/CLI update edits these layers and nothing else.

## The boundary

The desktop↔server wire format (the `/agent/v2/stream` SSE vocabulary, decision bodies, `/code-assist` events) is **ours** and versioned by `SERVER_API_VERSION` — it does not change when the SDK does, with one documented exception (`approval_request.questions`, passed through verbatim).

The agent/v2 vocabulary is declared by `schema/agent-v2/agent-v2.schema.json` and gated by `scripts/conformance-agent-v2.mjs`, which diffs what the server emits against what the desktop UI actually decodes. It is **not** defined by `extension/llm_agent/sdk/events.mjs` alone: that file produces 8 of the 15 variants, and four more are emitted from outside the linker. See `schema/agent-v2/SCHEMA.md` for the emitter map. The linker is drawn so both endpoints of that vocabulary sit inside linker files:

```text
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
┌─ Desktop linker ─────────────────────────────┐
│ ui/screens/chat/                             │
│   events.ts       wire decode                │
│   controller.ts   request/mapping            │
│   state.ts        tool names and approvals   │
└──────────────────────────────────────────────┘
               ▲
   everything else (routes, engines, views)
   consumes linker exports only
```

Enforcement:

- **Server**: ESLint (`extension/eslint.config.mjs`, `CLAUDE_SDK_IMPORT`) rejects any import of `@anthropic-ai/claude-agent-sdk` outside `llm_agent/sdk/` (tests exempt). Zero-violation ratchet, like the layer rules.
- **Server boot**: the SDK and `engine.mjs` are loaded lazily (first chat turn, or the post-listen prewarm) — never statically from a module on the boot path. Pinned by `extension/tests/lazy-engine.test.mjs`; see `extension/CLAUDE.md` "Lazy engine".
- **Desktop**: convention — keep new Claude knowledge (tool names, flags, model ids, error codes) inside `ui/screens/chat/` (`events.ts`, `controller.ts`, `state.ts`); other screens consume it.

## What lives where

| Knowledge | Owner |
|---|---|
| `@anthropic-ai/claude-agent-sdk` import, `query()` options, resume semantics, `canUseTool` | `extension/llm_agent/sdk/engine.mjs` |
| SDK message → wire event mapping | `extension/llm_agent/sdk/events.mjs` |
| SDK transcript disk layout (`CLAUDE_CONFIG_DIR`, `~/.claude/projects/…`) | `extension/llm_agent/sdk/transcripts.mjs` |
| Provider id the SDK engine meters under | `AGENT_SDK_PROVIDER` in `constants.mjs` (no imports, so routes can use it without loading the engine; re-exported by `engine.mjs`) |
| Auth ladder (`resolveAnthropicKey`) + per-user engine home (`agentSdkHomeFor`) | `extension/llm_agent/sdk/auth.mjs` (SDK-free; re-exported by `engine.mjs`) |
| `claude` CLI argv (`-p`, `--output-format stream-json`, `--mcp-config`, …), stream-json parsing, model-id regex, 500k prompt cap | `extension/providers/providers.mjs` + `runtime.mjs` |
| Where the `claude` executable is: `LLMIDE_CLAUDE_PATH`, SDK-bundled binary, PATH + well-known install dirs (validated: regular executable, not in a world-writable dir, `--version` probe); memoised with TTL; `CLAUDE_NOT_FOUND` typed error. Used by the SDK engine (`pathToClaudeCodeExecutable`, bundled binary first) and the CLI spawn paths (`cliBinFor`, plugin CLI; installed `claude` first) | `extension/providers/claude-path.mjs` |
| `claude plugin …` argv (marketplace update, list --available --json, update --json --accept-command) and its JSON parsing | `extension/providers/claude-plugin-cli.mjs` |
| SDK pin | `extension/package.json` (`@anthropic-ai/claude-agent-sdk`) |
| SDK surface ledger (adopted / ignored / needs-human per top-level item) | `extension/llm_agent/sdk/sdk-surface.json` (gate: `tests/sdk-surface-ledger.test.mjs`, tool: `scripts/sdk-surface.mjs`) |
| Wire event decode (desktop) | `ui/screens/chat/events.ts` |
| v2 request body, event→result mapping, `SESSION_UNRESUMABLE` handling | `ui/screens/chat/controller.ts` |

## SDK update playbook

On the next `@anthropic-ai/claude-agent-sdk` (or `claude` CLI) bump, work in this order:

1. **Pin**: bump `extension/package.json`, run `npm install`; `tests/dependency-pins.test.mjs` pins the version.
2. **Server linker**: fix what the new SDK changed —
   `llm_agent/sdk/engine.mjs` (query options, permission modes, resume), `events.mjs` (message shapes — keep the OUTPUT wire format identical; absorb changes here), `tools.mjs`/`hooks.mjs`/`decisions.mjs`, `transcripts.mjs` (disk layout), and for CLI-flag changes `providers/providers.mjs` + `runtime.mjs` + `web-client.mjs`.
3. **Tests**: `cd extension && npm test` — the SDK-shaped suites are `agent-v2-events`, `agent-v2-tools`, `agent-v2-routes`, `agent-sdk-spike`, `providers`, `spawn-cli-stream`, `stream-model-reply`, `mcp-cli-args`, `mcp-runclaude-args`, `cli-concurrency-cap`, `dependency-pins`, `sdk-surface`, `sdk-surface-ledger`.
4. **Adopt**: `tests/sdk-surface-ledger.test.mjs` fails until every new or removed top-level SDK item is classified in `llm_agent/sdk/sdk-surface.json`. By hand: `node scripts/sdk-surface.mjs diff --batch "$TMPDIR/b.md"` lists what is unclassified.
   - **What the loop does**: the `sdk-adoption` default loop (LLM-IDE checkout only, scheduled) classifies each new item in a worktree, implements server-only additive items (inside `llm_agent/sdk/` or `providers/`, wire shape unchanged) with a test in a top-level `extension/tests/sdk-adopt-<name>.test.mjs` (the only test files the loop's agent may write; every other test stays protected, and a subdirectory would change how `/bin/sh` expands the `npm test` glob), and marks anything needing a wire, desktop UI, permission or auth change `needs-human`. The result is a proposal in Settings › Self-Heal; nothing reaches main until you apply it. A version whose record is already proposed, needs-human, ignored or fixed is skipped on later ticks; a version-only bump with no new top-level item is recorded fixed.
   - **The seed backlog is human-only**: entries whose reason starts with `seed: not yet reviewed` were written by `init` when the ledger was created and are never re-offered to the loop. Count them (from `extension/`): `node -e 'const l=require("./llm_agent/sdk/sdk-surface.json");console.log(Object.values(l.items).filter(e=>e.reason?.startsWith("seed:")).length)'`.
   - **Coverage is top-level surface only**: `Options` keys, `SDKMessage` union members, `Query` methods and tool input types. Nested settings and control-protocol fields are not detected, so a green gate does not mean a release added nothing — read the SDK changelog for those.
5. **Desktop linker — only if the wire had to change** (new event type, new tool name, new approval arg): `ui/screens/chat/events.ts`, `controller.ts`, `state.ts`. Bump `SERVER_API_VERSION` for **any** change to the wire format or the `ENDPOINTS` list (that list drives the client's stale-server banner), see `invariants.md`; additive, off-chat changes need no client floor change.
6. **Verify**: `make test && make regression && make lint`, then one live chat turn per engine (v2 + legacy) against a running server.

Anything the update forces you to edit **outside** these files is a boundary leak — move the knowledge into the linker as part of the same change, and extend this page's table.

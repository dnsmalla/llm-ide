# MCP Plugin Runtime (SP1) — active integrations vs discovery catalog

- **Date:** 2026-08-12
- **Status:** Design (not yet implemented)
- **Scope:** The first sub-project of the plugin/llm-sources split — a minimal MCP-client runtime that lets the agent actively connect to and call tools from an MCP server imported from Claude Code's own config.

## Background — the conflict this resolves

Two systems had drifted into overlap:

- **Plugins** (`extension/plugins/`) load markdown skills / slash-commands / subagents and import Claude-Code skills (`claude-adapter.mjs`).
- **LLM sources** (`extension/llm-sources/`) catalog skills / agents / hooks / MCP servers — discovery-only.

Both surface *skills* and *agents*, and "app plugins like Slack, Linear" are themselves usually MCP servers — so MCP appeared on both sides with no clear rule for which system does what.

### The agreed boundary

- **Plugins = run.** Things the agent actively connects to and invokes at runtime: **active MCP connections**, plus executable **slash-commands** and **subagents**.
- **LLM sources = browse.** A read-only catalog: skills (attach-as-context), and listings of agents / hooks / MCP servers. Nothing in a source is ever executed, spawned, or auto-connected.

The same MCP server can appear in both: cataloged in a source for browsing, but only *connected* when installed as a plugin.

## Decomposition (this doc covers SP1 only)

The full rework is several subsystems. Build order:

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| **SP1** *(this doc)* | MCP-client runtime core | Minimal stdio MCP client; connect one server imported from `~/.claude.json`; consent gate; agent-loop wiring. One live plugin whose tools the agent can call. | nothing |
| SP2 | Claude marketplace bundle import | Extend `claude-adapter` to read `.mcp.json` + commands + agents from installed/marketplace bundles. | SP1 |
| SP3 | Codex import path | Mirror the Claude adapter for Codex's plugin/MCP format. | SP1 |
| SP4 | Migrate markdown skills → llm-sources | Move plugin skill-loading into the llm-sources catalog; plugins shed all skill loading and keep commands + subagents + active MCP. Independent of SP1–3. | independent |

## SP1 scope

### In scope

- A hand-rolled **minimal stdio MCP client** (no new dependency): spawn, JSON-RPC 2.0 framing, `initialize`, `tools/list`, `tools/call`, lifecycle, timeouts.
- **Import source:** read the user's existing Claude `~/.claude.json` `mcpServers` map (the same file Claude Code reads) and register one server as an active plugin. Read-only — we never mutate that file.
- **Consent + enable gate** before any spawn (the capability llm-sources deliberately avoided).
- **Agent-loop wiring:** surface the connected server's tools to the model and dispatch calls.
- **Mac UI** to scan/import, consent, enable, and inspect tools.

### Non-goals (explicitly deferred)

- HTTP/SSE transports and the official `@modelcontextprotocol/sdk` (later SP1b).
- Marketplace *bundle* import carrying commands/agents (SP2); Codex import (SP3); markdown-skill migration (SP4).
- Auto-restart loops, per-server rate limiting, MCP resources/prompts (SP1 is **tools only**).

## Architecture

New module `extension/mcp/`, sibling to `plugins/` and `llm-sources/`, kept isolated from the markdown-plugin code that SP4 will refactor. Respects the layering rule (`core ← kb ← server ← agents / mcp / plugins / llm-sources`): `client.mjs` is a pure Node primitive; `manager.mjs` is stateful and consumed by the server and `llm_agent/`.

```
extension/mcp/
├── client.mjs        // stdio JSON-RPC primitive (spawn, frame, initialize, tools/list, tools/call)
├── manager.mjs       // per-user connection lifecycle + consent gate + tools cache
├── state.mjs         // mcp-plugins.json registry + per-user enable/consent (atomic JSON; mirrors llm-sources/state.mjs)
└── claude-source.mjs // read-only scan of ~/.claude.json mcpServers
```

## Data model

- **Registry** (system-wide, admin-owned): `~/Library/Application Support/llm-ide/mcp-plugins.json`
  ```
  McpPlugin { id, name, command, args[], env?, source: 'claude'|'manual', builtin: false }
  ```
- **Per-user state:** `mcp-plugins-state.json`, keyed by `userId` → `{ enabled: bool, consented: bool }`.
- `id` is a server-validated slug (`/^[a-z][a-z0-9-]{1,40}$/`), matching the convention used by llm-sources and plugins.

## Connection lifecycle

`manager.mjs` holds `Map<"userId:pluginId", Connection>` — one connection per user + plugin.

- **Enable + consented → eager `connect()`**: spawn, `initialize` handshake, `tools/list`, cache the tool list so the roster is ready when the agent builds it. Eager connect fail-fast at consent/enable time (the user learns immediately if the server won't start).
- **Disable →** `disconnect()` (close stdin → SIGTERM → SIGKILL after grace), then drop the entry. MCP has no formal shutdown RPC; we just tear the transport down.
- **Idle timeout (~10 min) →** disconnect to reclaim the process; reconnect on next request.
- **Unexpected process `exit` →** mark disconnected, surface the error to the UI; **no auto-restart loop** (avoid a crash/thundering-herd). Reconnect on next use or manual retry.

## Trust & consent model

This is the single most important property, because installing an MCP plugin = registering a command that runs arbitrary code:

- **Admin registers** a plugin (scan `~/.claude.json`, pick a server, or enter `{command, args, env}` manually).
- **User must explicitly consent + enable** before the manager ever spawns it. Consent is per-user, per-plugin, revocable.
- Scanning `~/.claude.json` is **inert** (read-only); spawn happens only on enable-after-consent.

## MCP client internals (`client.mjs`)

stdio transport: `spawn(command, args)` with merged env; stdin/stdout carry newline-delimited JSON-RPC 2.0 (per the MCP stdio spec); stderr captured for diagnostics. A readline loop parses stdout line-by-line; an integer `id` counter + `Map<id, {resolve, reject}>` correlates requests to responses.

Operations:

- `connect()` — send `initialize` (protocolVersion + client info; 60s timeout for `npx` cold start) → read server capabilities → send `notifications/initialized`.
- `listTools()` — `tools/list` → `{name, description, inputSchema}[]` (cached by the manager).
- `callTool(name, args)` — `tools/call` → `{content, isError}`; `isError` surfaces as a tool error to the agent.
- `disconnect()` — close stdin → SIGTERM → SIGKILL after grace.

Robustness: malformed lines are logged and skipped (never crash the client); a per-message size cap mirrors the llm-sources M2 guard; per-request timeout (30s default) rejects stale calls.

## Agent-loop wiring

Today `buildPerUserSkillSet(userId)` (in `extension/llm_agent/skills/registry.mjs`) returns `{ skills, commands, subagents }`; consumed by `extension/llm_agent/runtime/route.mjs`. SP1 adds a fourth channel, **`mcpTools`**, via a new `mcpToolsForUser(userId)` in `manager.mjs` that returns cached descriptors for the user's enabled + consented plugins.

At each agent request, `route.mjs`:

1. `ensureConnected(userId, pluginId)` for each enabled MCP plugin (async reconnect if the idle-timeout dropped it) so the roster is current.
2. Exposes every tool as **`mcp__<pluginSlug>__<toolName>`** in the tool roster (Claude Code's convention; the prefix cannot collide with builtins), with the plugin name prepended to the description.
3. Routes any `mcp__…` tool call to a single generic dispatcher that resolves the connection and calls `callTool`.

**Restricted modes & safety:** MCP tools can mutate the world (post to Slack), so they join the **write-tool** set for restriction — `plan` / `review` / `document` sessions filter them out exactly like other write tools. Tool results pass through the same `SecretRedactor` and `<<<TOOL_CALL>>>` forgery defenses the loop already applies.

## HTTP surface

Mirrors the llm-sources auth pattern: admin-gated writes, per-user consent/enable, every mutation audited (`action: 'mcp-plugin.*'`), paths registered in `ENDPOINTS` and `SERVER_API_VERSION` bumped (28 → 29).

| Method | Endpoint | Body / Query | Purpose |
|---|---|---|---|
| GET | `/auth/me/mcp-plugins` | — | Plugins + this user's consent/enable + connection status + tool count |
| GET | `/auth/me/mcp-plugins/claude-sources` | — | *(admin)* read-only scan of `~/.claude.json` `mcpServers` |
| POST | `/auth/me/mcp-plugins/add` | `{claudeName}` **or** `{command, args?, env?, name}` | *(admin)* register a plugin — either import a server by its name in `~/.claude.json`, or enter one manually |
| POST | `/auth/me/mcp-plugins/consent` | `{id, consented}` | *(user)* record consent (prereq to connect) |
| POST | `/auth/me/mcp-plugins/toggle` | `{id, enabled}` | *(user)* connect / disconnect |
| DELETE | `/auth/me/mcp-plugins/<id>` | — | *(admin)* unregister + disconnect all |
| GET | `/auth/me/mcp-plugins/<id>/tools` | — | *(user)* connected server's tools (detail view) |

## Mac UI

Library → Plugins gains an **MCP Plugins** sub-section (parallel to LLM Sources). Row: name, `claude` source badge, connection state (connected / idle / error), tool count, consent toggle, enable toggle. Header menu: **"Add from Claude Code…"** lists `~/.claude.json` servers. Detail view lists the server's tools (name + description).

New `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+McpPlugins.swift` DTOs mirror the routes, using the `decodeIfPresent ?? default` back-compat pattern (per the llm-sources F1 lesson) for any field added in a later bump.

## Testing

- **`client.mjs`** against a fake in-process MCP server (a tiny Node script speaking stdio JSON-RPC): `initialize` handshake, `tools/list`, `tools/call` success + `isError`, request timeout, process-crash/exit handling, malformed-line tolerance.
- **`manager.mjs`**: connect/disconnect lifecycle, idle timeout, **consent gating (no spawn without consent)**, per-user isolation, tools cache invalidation on reconnect.
- **HTTP**: admin-gate (non-admin → 403 on add/delete; user may consent + toggle), `~/.claude.json` scan fixture, slug validation, consent + toggle flow end-to-end.
- **Agent loop**: `mcpToolsForUser` returns connected tools; `mcp__` dispatch calls the correct connection; restricted mode excludes MCP tools. Uses the fake MCP server fixture.

## Files touched (SP1)

**Server:**
- new `extension/mcp/{client,manager,state,claude-source}.mjs`
- `extension/llm_agent/skills/registry.mjs` — add `mcpTools` channel to `buildPerUserSkillSet`
- `extension/llm_agent/runtime/route.mjs` — roster inclusion + `mcp__` dispatcher + restricted-mode filtering
- `extension/server/auth-routes.mjs` — seven new routes
- `extension/server.mjs` — `ENDPOINTS` + `SERVER_API_VERSION` bump

**Mac:**
- new `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+McpPlugins.swift`
- `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift` — MCP Plugins sub-section + Add-from-Claude flow

**Tests:**
- new `extension/tests/mcp-client.test.mjs`, `extension/tests/mcp-manager.test.mjs`, additions to `extension/tests/auth-routes.test.mjs`
- new fake MCP server fixture under `extension/tests/fixtures/`

# MCP Plugin Runtime (SP1) — active integrations via the Claude CLI

- **Date:** 2026-08-12
- **Status:** Design (not yet implemented)
- **Scope:** The first sub-project of the plugin/llm-sources split — let the agent actively use MCP servers (Slack, Linear, …) imported from Claude Code's own config, by delegating connection + dispatch to the Claude CLI's native `--mcp-config` support.

> **Re-scoped 2026-08-12** after reading the agent-loop code. The original draft
> assumed a hand-rolled MCP client as *the* mechanism. The codebase actually has
> two agent loops: the default **Claude CLI path** (which already speaks MCP
> natively via `claude -p --mcp-config`) and the **native loop** for
> deepseek/openai/custom providers (which has no CLI to delegate to). SP1 now
> targets only the Claude path — where the CLI does the work — and the
> hand-rolled client is split off to **SP1b** for non-Claude providers.

## Background — the conflict this resolves

Two systems had drifted into overlap:

- **Plugins** (`extension/plugins/`) load markdown skills / slash-commands / subagents and import Claude-Code skills (`claude-adapter.mjs`).
- **LLM sources** (`extension/llm-sources/`) catalog skills / agents / hooks / MCP servers — discovery-only.

Both surface *skills* and *agents*, and "app plugins like Slack, Linear" are themselves usually MCP servers — so MCP appeared on both sides with no clear rule.

### The agreed boundary

- **Plugins = run.** Things the agent actively connects to and invokes at runtime: **active MCP connections**, plus executable **slash-commands** and **subagents**.
- **LLM sources = browse.** A read-only catalog: skills (attach-as-context), and listings of agents / hooks / MCP servers. Nothing in a source is ever executed, spawned, or auto-connected.

The same MCP server can appear in both: cataloged in a source for browsing, but only *connected* when installed as a plugin.

## Decomposition (this doc covers SP1 only)

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| **SP1** *(this doc)* | MCP plugins via Claude CLI `--mcp-config` | Import an MCP server from `~/.claude.json`; admin-installs/user-consents; inject `--mcp-config` + `--allowedTools "mcp__*"` into `claude -p` for the default Claude path so the agent can call its tools. | nothing |
| SP1b | Hand-rolled MCP client for the native loop | A stdio JSON-RPC client so deepseek/openai/custom providers can use MCP plugins (no CLI to delegate to). | SP1 |
| SP2 | Claude marketplace bundle import | Extend `claude-adapter` to read `.mcp.json` + commands + agents from installed/marketplace bundles. | SP1 |
| SP3 | Codex import path | Mirror the Claude adapter for Codex's MCP/plugin format. | SP1 |
| SP4 | Migrate markdown skills → llm-sources | Move plugin skill-loading into the llm-sources catalog; plugins shed all skill loading and keep commands + subagents + active MCP. Independent of SP1–SP1b. | independent |

## SP1 scope

### In scope

- **Import source:** read the user's existing Claude `~/.claude.json` `mcpServers` map (the same file Claude Code reads) and register one as an active plugin. Read-only — we never mutate that file.
- **Consent + enable gate** before the agent ever gets the server (the capability llm-sources deliberately avoided).
- **Agent integration via the CLI:** when the user has enabled + consented MCP plugins and the turn is not a restricted mode, swap the existing `--strict-mcp-config` (which loads zero MCP servers today) for `--mcp-config <json>` + `--allowedTools "mcp__*"`. The Claude CLI connects to the servers and dispatches `mcp__<server>__<tool>` calls natively — we do **not** build a client or wire our own dispatch for SP1.
- **Restricted-mode enforcement:** plan/review/document turns keep `--strict-mcp-config` (or pass `--disallowed-tools "mcp__*"`) so restricted sessions never call MCP tools.
- **Mac UI** to scan/import, consent, enable.

### Non-goals (explicitly deferred)

- The hand-rolled MCP client and native-loop (deepseek/openai/custom) wiring (**SP1b**).
- HTTP/SSE-specific handling beyond what `--mcp-config` already carries (CLI supports both).
- Marketplace *bundle* import carrying commands/agents (SP2); Codex import (SP3); markdown-skill migration (SP4).
- A live `tools/list` of each server's tools in the detail view — needs a client (SP1b). SP1 shows the registered command/args + state.
- OAuth-requiring MCP servers (the headless CLI can't complete OAuth; users must `claude mcp login <name>` interactively first — documented, not automated).

## Architecture

A new `extension/mcp/` module, sibling to `plugins/` and `llm-sources/`. SP1 is small because the CLI owns the connection — there is **no connection manager, no tools cache, no idle/restart logic** (the CLI connects fresh per `claude -p` invocation, waiting up to `MCP_TIMEOUT`).

```
extension/mcp/
├── state.mjs          // mcp-plugins.json registry + per-user enable/consent (atomic JSON; mirrors llm-sources/state.mjs)
├── claude-source.mjs  // read-only scan of ~/.claude.json mcpServers
└── mcp-config.mjs     // buildMcpConfigForUser(userId, { mode }) → { mcpConfigJson, allowed } | null
```

Integration point: **`runClaude`** (`extension/agents/runtime.mjs`) → **`spawnCli`** (`extension/agents/providers.mjs`), which already accepts an `args: argsOverride`. SP1 threads a mode-aware MCP config from `handleCodeAssist` through the agent loop into `runClaude`, which builds the `argsOverride` (replacing `--strict-mcp-config`).

## Data model

- **Registry** (system-wide, admin-owned): `~/Library/Application Support/llm-ide/mcp-plugins.json`
  ```
  McpPlugin { id, name, command, args[], env?, source: 'claude'|'manual', builtin: false }
  ```

  > **Update (2026-08-21):** the record gained a **transport**. It was stdio-only
  > (`command` required), which meant none of the servers coders actually reach for
  > could be registered — GitHub, Sentry, Notion and friends are hosted now — and the
  > `~/.claude.json` importer had to drop `type: "http"` entries on the floor, so a
  > config whose only server was remote scanned as empty. Current shape:
  > ```
  > McpPlugin { id, name, transport: 'stdio'|'http'|'sse', builtin: false,
  >             source: 'claude'|'codex'|'catalog'|'manual',
  >             command?, args[], env?,        // stdio
  >             url?, headers?,                // http | sse
  >             credential? }                  // { vaultKey, target, name, template?, label? }
  > ```
  > A missing `transport` reads as `stdio` (every pre-existing record required
  > `command`), so no migration was needed. `credential` is a DESCRIPTOR: the value
  > lives in the encrypted vault under the `mcp.<server>.<field>` namespace and is
  > injected by `mcp-config.mjs` when `--mcp-config` is built, so no token is written
  > into this shared file. Because `mcp/` sits below `server/` in the layer table, the
  > vault reader is injected (`makeSecretReader`) by the callers that may import it
  > rather than imported here. Added alongside: a curated catalog
  > (`mcp/catalog.mjs`, `GET /auth/me/mcp-plugins/catalog`, add via `{ catalogId, arg }`)
  > and a manual-add form — before this, importing from a CLI config was the only way
  > in. `SERVER_API_VERSION` 36.
- **Per-user state:** `mcp-plugins-state.json`, keyed by `userId` → `{ enabled: bool, consented: bool }`.
- `id` is a server-validated slug (`/^[a-z][a-z0-9-]{1,40}$/`), matching the convention used by llm-sources and plugins.

## Trust & consent model

Installing an MCP plugin = registering a command the agent will run (via the CLI). So:

- **Admin registers** a plugin (scan `~/.claude.json`, pick a server, or enter `{command, args, env}` manually).
- **User must explicitly consent + enable** before the manager ever includes it in `--mcp-config`. Consent is per-user, per-plugin, revocable.
- Scanning `~/.claude.json` is **inert** (read-only); the server reaches the agent only when an enabled+consented plugin is present on a non-restricted turn.

## Agent integration (`runClaude` → `spawnCli`)

Today the Claude path invokes `claude -p` with `--strict-mcp-config` (zero MCP servers) + `--tools ''` (built-ins off; the project runs its own tool loop) — see `providers.mjs` `CLI_ARG_BUILDERS.anthropic` and the comment at `runtime.mjs:408-411`.

SP1 adds one mode-aware branch: when `buildMcpConfigForUser(userId, { mode })` returns a non-null config (i.e. the user has ≥1 enabled+consented plugin **and** the mode is not restricted), `runClaude` passes an `argsOverride` to `spawnCli` that:

- replaces `--strict-mcp-config` with `--mcp-config <json>` (the JSON lists the user's enabled+consented servers in Claude-Code `.mcp.json` shape), and
- adds `--allowedTools "mcp__*"` so the model may call them autonomously in headless mode.

Otherwise (no plugins, disabled, not consented, **or restricted mode**) the call is identical to today — `--strict-mcp-config`, no MCP. Restricted modes therefore enforce the "no MCP in plan/review/document" rule at the flag level.

The tool name the model uses is `mcp__<pluginId>__<tool>` (the CLI's native convention); because the CLI dispatches these itself, SP1 does **not** add MCP entries to route.mjs's `handlers` map or to `buildPerUserSkillSet`.

> **To validate during implementation:** confirm `--tools ''` (built-ins off) does not also suppress `--mcp-config` tools. If it does, the adjustment is to use `--disallowed-tools` for built-ins on MCP turns rather than `--tools ''`. The end-to-end test (fake MCP server) gates this.

## HTTP surface

Mirrors the llm-sources auth pattern: admin-gated writes, per-user consent/enable, every mutation audited (`action: 'mcp-plugin.*'`), paths registered in `ENDPOINTS` and `SERVER_API_VERSION` bumped (28 → 29).

| Method | Endpoint | Body | Purpose |
|---|---|---|---|
| GET | `/auth/me/mcp-plugins` | — | Plugins + this user's consent/enable state |
| GET | `/auth/me/mcp-plugins/claude-sources` | — | *(admin)* read-only scan of `~/.claude.json` `mcpServers` |
| POST | `/auth/me/mcp-plugins/add` | `{claudeName}` **or** `{command, args?, env?, name}` | *(admin)* register a plugin |
| POST | `/auth/me/mcp-plugins/consent` | `{id, consented}` | *(user)* record consent (prereq to inclusion in `--mcp-config`) |
| POST | `/auth/me/mcp-plugins/toggle` | `{id, enabled}` | *(user)* enable / disable |
| DELETE | `/auth/me/mcp-plugins/<id>` | — | *(admin)* unregister |

(No `/<id>/tools` route in SP1 — listing a server's tools needs a client, deferred to SP1b.)

## Mac UI

Library → Plugins gains an **MCP Plugins** sub-section (parallel to LLM Sources). Row: name, `claude` source badge, enabled toggle, consented indicator. Header menu: **"Add from Claude Code…"** lists `~/.claude.json` servers. Detail view shows the registered command/args + state (no live tool list until SP1b).

New `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+McpPlugins.swift` DTOs mirror the routes, using the `decodeIfPresent ?? default` back-compat pattern (per the llm-sources F1 lesson).

## Testing

- **`state.mjs`**: registry CRUD, slug validation, per-user consent/enable isolation, atomic write (mirrors the llm-sources state tests).
- **`claude-source.mjs`**: scan a `~/.claude.json` fixture (with and without `mcpServers`); never mutates the file.
- **`mcp-config.mjs`**: `buildMcpConfigForUser` returns null when (a) no plugins, (b) none enabled, (c) none consented, (d) restricted mode; returns the JSON with exactly the enabled+consented servers otherwise.
- **`runClaude`/`spawnCli` arg injection**: when MCP applies, the `argsOverride` contains `--mcp-config` + `--allowedTools "mcp__*"` and NOT `--strict-mcp-config`; when it doesn't, args are byte-identical to today. Restricted mode never sets `--allowedTools "mcp__*"`.
- **End-to-end (gated):** a fake stdio MCP server fixture + a real `claude -p --mcp-config …` call asserts the model can invoke `mcp__<server>__<tool>`. Skipped in CI if `claude` isn't available / not logged in (guard, don't fail).
- **HTTP**: admin-gate (non-admin → 403 on add/delete; user may consent + toggle), `~/.claude.json` scan fixture, slug validation, consent + toggle flow.

## Files touched (SP1)

**Server:**
- new `extension/mcp/{state,claude-source,mcp-config}.mjs`
- `extension/agents/runtime.mjs` — `runClaude` accepts an `mcpConfig` option and builds the `spawnCli` `argsOverride`; same for `runClaudeStream`
- `extension/agents/providers.mjs` — a helper to build the MCP-aware anthropic args (reusing the existing `argsOverride` path; `CLI_ARG_BUILDERS` unchanged for the non-MCP case)
- `extension/llm_agent/runtime/route.mjs` — compute `mcpConfig` (mode-aware) and thread it through the agent-loop call (global agent only; subagent/internal stay MCP-free)
- `extension/server/auth-routes.mjs` — six new routes
- `extension/server.mjs` — `ENDPOINTS` + `SERVER_API_VERSION` bump (28 → 29)

**Mac:**
- new `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+McpPlugins.swift`
- `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift` — MCP Plugins sub-section + Add-from-Claude flow

**Tests:**
- new `extension/tests/mcp-state.test.mjs`, `extension/tests/mcp-config.test.mjs`, `extension/tests/mcp-claude-source.test.mjs`, additions to `extension/tests/auth-routes.test.mjs`, an `extension/tests/fixtures/fake-mcp-server.mjs`

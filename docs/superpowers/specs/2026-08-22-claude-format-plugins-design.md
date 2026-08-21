# Claude-Format Plugins for LLM-IDE — Design

**Date:** 2026-08-22
**Status:** Approved design, pending implementation plan
**Approach:** C — Hybrid (native Claude-format loader + per-engine component routing)
**Hook trust model:** Per-plugin consent gate (stronger than Claude Code's default, consistent with LLM-IDE's MCP consent model)

## Context

LLM-IDE's plugin system (`extension/plugins/`) supports markdown-only plugins:
skills, slash commands, and subagents. Plugins cannot declare hooks or MCP
servers, and the Claude import adapter is lossy — it copies only `skills/` and
`commands/` (flattening skill directories), drops `agents/` and `hooks/`, and
never parses `.claude-plugin/plugin.json`. MCP support is strong on the legacy
CLI chat path (catalog, consent+enable, vault credentials, imports) but absent
from the v2 Agent-SDK engine and discarded on the native loop. Four
refresh/updates endpoints are orphaned (backend-only, no UI).

The Claude Code plugin standard (`code.claude.com/docs/en/plugins-reference`)
defines a richer package: `.claude-plugin/plugin.json` manifest, `skills/<name>/SKILL.md`
directories, `agents/`, `commands/`, `hooks/hooks.json` (31 events, 5 handler
types), plugin-scoped `.mcp.json` servers, and `.claude-plugin/marketplace.json`
distribution. Codex's `.codex-plugin/plugin.json` is a near-subset (its hooks
even accept `CLAUDE_PLUGIN_ROOT` compatibility variables).

**Goal:** adopt the Claude plugin format natively so the existing ecosystem
installs and works, without disturbing any current feature or persisted state.

## Hard constraints (user-mandated)

1. **Existing features are unaffected.** Every current capability —
   own-format plugins, Library UI, MCP catalog, Claude/Codex imports, the
   legacy chat path — behaves exactly as before. Enforced mechanically: the
   Regression Loop stage must stay green at every phase.
2. **Settings and state work as before.** All state files
   (`plugin-state.json`, `mcp-plugins.json`, `mcp-plugins-state.json`) load
   unchanged; new fields are additive only.

## Architecture

`extension/plugins/loader.mjs` gains a format detector:

- `.claude-plugin/plugin.json` present → Claude format
- `.codex-plugin/plugin.json` present → same loader (near-subset)
- own `plugin.json` → today's code path, untouched

Both formats normalize into a single internal model (manifest + component
lists) so downstream consumers are format-agnostic:

- `buildPerUserSkillSet(userId)` — skills/commands/subagents merge
- MCP registry (`extension/mcp/state.mjs`) — plugin-scoped servers
- hook runner — v2 engine only (phase 3)

The existing install (zip upload, no server-side fetch), uninstall, symlink
rejection, content caps, and per-user enable state are reused unchanged.

## Phase 1 — Loader parity

- Parse `.claude-plugin/plugin.json`: `name` (required), `displayName`,
  `version`, `description`, `author`, component-path overrides
  (`skills`, `commands`, `agents`, `hooks`, `mcpServers`), `defaultEnabled`
  (display only — LLM-IDE stays opt-in: a new plugin is never auto-enabled,
  regardless of the manifest). Unrecognized fields ignored. Name validated
  with the existing regex and reserved-name rules.
- **Skills:** accept both `skills/<name>/SKILL.md` directories and flat
  `skills/<name>.md`. Map Claude frontmatter (`description`,
  `disable-model-invocation`); inject `name`/`kind: read` as the import
  adapter does today. Respect existing size caps (64KB per skill).
- **Commands:** `commands/*.md` with frontmatter `description`/`args`;
  support both `$ARGUMENTS` and `{{arg}}` substitution in bodies.
- **Agents:** `agents/*.md` frontmatter maps onto the existing subagent
  model — `tools` → `allowed_tools`, `maxTurns` → `maxIterations` (clamped
  to the existing cap of 5, default 3), `model` → sub-model override.
- **Unsupported components** (themes, output-styles, `.lsp.json`, monitors,
  workflows, `bin/`, root `settings.json`): install succeeds; components are
  catalogued for display as "unsupported — ignored"; never executed.
- **Import adapter upgrade:** Claude/Codex import stops dropping `agents/`
  and stops flattening. A Claude-format source plugin is copied whole —
  directory layout preserved, no generated manifest — and registered with
  `origin: 'claude'` metadata as today. The lossy per-file adaptation path
  remains only for sources without a plugin manifest.
- Precedence unchanged: core skills > own-format plugins > imported plugins.

## Phase 2 — MCP everywhere

- **Plugin `.mcp.json`:** when a plugin is installed, its servers register
  into `extension/mcp/state.mjs` as `plugin:<plugin-name>`-scoped entries
  with `consented: false` initially — the user consents and enables them
  exactly like any MCP server today. Disabling/uninstalling the plugin
  disables/removes its servers. Manifest env placeholders route to vault
  credential descriptors as current MCP entries do.
- **v2 Agent-SDK engine:** a `buildPerUserMcpServers(userId)` builder passes
  enabled+consented servers (stdio command/args/env, HTTP url/headers) as
  SDK MCP server options, mounted alongside the existing in-process `llmide`
  server. This closes the biggest current gap: the v2 engine having no user
  MCP at all.
- **Legacy CLI path:** unchanged (`--mcp-config` + `--strict-mcp-config`).
- **Native loop (OpenAI/Gemini/custom providers):** remains MCP-less,
  documented explicitly as unsupported (no MCP client exists there).
- **Fixes shipped in this phase:** the `credentialMissing` warning gets a
  real "Add credential" action writing the vault key directly; the MCP
  detail view refreshes the sidebar after consent/toggle/remove.

## Phase 3 — Hooks with consent gate

- Parse `hooks/hooks.json` (Claude and Codex layouts share the format).
  Hook declarations are stored in plugin state (additive field).
- New per-plugin `hooksConsented` flag, default **false**. PluginDetailView
  gets a "Trust hooks" toggle with an explicit warning that enabling runs
  shell commands from this plugin.
- **Execution: v2 SDK engine only.** Plugin hooks translate into SDK hook
  options for the events the SDK supports. `command` handler type only in
  this phase; `http`/`mcp_tool`/`prompt`/`agent` handlers display but do
  not run (the same subset Codex executes today).
- Non-SDK paths (legacy CLI, native loop) show hooks catalogued-only.
- Hook commands run with a timeout and output cap, under the same
  approval-gate environment as other act actions.

## Phase 4 — Marketplace + updates UI

- Library "+" menu gains **"Add marketplace…"**: client-side fetch of
  `.claude-plugin/marketplace.json` via the existing git installer (the
  server keeps its no-server-side-fetch posture), a browse sheet listing
  plugins, and per-plugin install through the existing zip endpoint.
- **Wire the orphaned endpoints:** `/auth/me/{claude,codex}-plugins/refresh`
  and `/updates` get UI — an update badge in the Plugins header and
  one-click re-import (the `checkForUpdates` backend already exists).
- **Copy/gate cleanup:** HelpGuideView's stale "Settings → Plugins" text
  corrected; the admin-gate contradiction resolved by keeping the
  `requireAdmin` gates and fixing the comments that claim they were dropped.
- **System Check:** new Plugins+MCP stage running the `mcp-*` suites
  alongside the existing plugin suites.

## Security

All existing guards carry over unchanged: 5MB zip cap, path-traversal and
symlink rejection, per-file and total size caps, prompt-injection warnings,
per-user opt-in enablement (never overridden by a manifest's
`defaultEnabled`). Additions: hook execution requires the explicit
per-plugin consent (never auto-on), hook commands are timeout- and
output-capped, and malformed manifests produce install errors naming the
offending file and field.

## Testing

- Loader: Claude/Codex-format fixtures (skills-dir layout, agents, hooks,
  `.mcp.json`, unsupported components, malformed manifests).
- Registry: agents-import coverage; name-collision precedence.
- MCP: plugin-scoped registration, consent gating, v2 option-building.
- Hooks: parse tests, consent-gate tests, SDK translation tests with a fake
  hook script (echo + exit-code blocking case).
- Mac UI: trust toggle, marketplace sheet, credential-add flow.
- Gates: full extension suite + `swift test` green each phase; Regression
  Loop stage green each phase (constraint #1 enforced mechanically).

## Non-goals

- No LSP servers, themes, output styles, monitors, workflows, or plugin
  evals — parsed-and-ignored at most.
- No MCP on the native provider loop.
- No server-side marketplace fetching (SSRF posture preserved).
- No retirement of the own-format plugin schema; it remains first-class.
- Plugin `userConfig`, `channels`, and cross-plugin `dependencies` are not
  implemented (manifest fields tolerated and ignored).

## Risks

- **SDK surface drift:** the Agent SDK's hook/MCP option surface evolves;
  pin the SDK version and translate at one seam (`sdk/engine.mjs`).
- **Two consumption paths** (legacy + v2) can diverge during the engine
  migration; the per-user component model is built once and consumed by
  both, with the v2 path authoritative as the migration completes.
- **Hook subset confusion:** users may expect a Claude plugin's http/prompt
  hooks to run; the UI labels non-executing handlers explicitly.

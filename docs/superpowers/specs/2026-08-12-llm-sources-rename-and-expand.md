# LLM Sources — rename + multi-kind discovery

- **Date:** 2026-08-12
- **Status:** Implemented
- **Supersedes:** `docs/superpowers/specs/2026-08-11-skills-sources-design.md` (design/naming below; the server + Mac implementation plans it links stay as historical execution records and are not rewritten)
- **Scope:** Rename the "skills source" registry to "LLM source", and generalize what a registered source can contribute from skills-only to skills + agents + hooks + MCP servers.

## Why

The original feature (`docs/superpowers/plans/2026-08-11-skills-sources-server.md`, `...-mac.md`) shipped a registry of skill repos. The request driving this doc: rename it to something that doesn't imply "skills only," and let a registered source also surface subagent definitions and hooks it contains — "collect all LLM related source... if there exist I want collect in there" (user's framing). The system should become the single place a repo's LLM-relevant resources are catalogued, not just skills. A same-day follow-up request added the fourth kind, MCP servers, to the same "collect everything" principle.

## What changed

**Naming**, mechanical, no behavior change:

| Old | New |
|---|---|
| `extension/skills-sources/` | `extension/llm-sources/` |
| `skills-sources.json`, `skills-sources-state.json` | `llm-sources.json`, `llm-sources-state.json` |
| `/auth/me/skills-sources/*` | `/auth/me/llm-sources/*` |
| `isValidSkillsSource()` | `isValidLlmSource()` |
| audit actions `skills-source.*` | `llm-source.*` |
| Swift `SkillsSourceInfo`/`SkillsSourceSummary`/`SkillsSourceRow`/`SkillsSourceDetailView`/`SkillsSourceAddSheet` | `LlmSourceInfo`/`LlmSourceSummary`/`LlmSourceRow`/`LlmSourceDetailView`/`LlmSourceAddSheet` |
| `ShellState.LibrarySelection.skillsSource(id)` | `.llmSource(id)` |
| Library sidebar section "Skills Sources" | "LLM Sources" |

`SERVER_API_VERSION` bumped 26 → 27 for the rename (endpoint paths changed — a real HTTP-surface break for any existing client), then → 28 when MCP servers were added (new response fields an older client doesn't decode) — per the bump convention documented in `server.mjs`.

**Scope expansion** — a registered source may now contribute four discoverable kinds instead of one:

1. **Skills** (unchanged) — `skills/`, `runtime/` families, `SKILL.md` frontmatter.
2. **Agents** — `agents/*.md`, same frontmatter shape as `SKILL.md` (Claude Code's own convention for standalone subagent definitions). `countDiscoveryAgents(dir)` / `listDiscoveryAgents(dir)`.
3. **Hooks** — `.claude-plugin/hooks/hooks.json` or a top-level `hooks/hooks.json` fallback, the Claude Code plugin-hook manifest shape (`{ "<Event>": [{ matcher?, hooks: [{type, command}] }] }`). `countDiscoveryHooks(dir)` / `listDiscoveryHooks(dir)`.

   > **Update (2026-08-21):** scanning only the plugin convention missed hooks declared the *settings* way — a `hooks` block inside `settings.json`, which is how the central skills kit declares its two (`config/tool/claude/settings.json`), so `builtin` reported 0 hooks while shipping 2. `listDiscoveryHooks` now reads both conventions (`hookManifestCandidates` in `llm-sources/registry.mjs`: the two plugin paths, plus `.claude/settings.json`, `settings.json`, and `config/tool/claude/settings.json`), unions every candidate that exists rather than stopping at the first, and de-duplicates on (event, matcher, command). `isValidLlmSource` accepts a settings-declared-hooks-only directory too, but asks the reader rather than trusting the presence of `settings.json` — otherwise nearly any project directory would qualify. Discovery-only is unchanged; nothing here became executable.
4. **MCP servers** — `.mcp.json` or a nested `.claude-plugin/.mcp.json` fallback, the Claude Code MCP-server manifest shape (`{ "mcpServers": { "<name>": { "command": string, "args"?: string[] } } }` — this is literally the file/shape the Claude Code CLI itself reads from a project root). `countDiscoveryMcpServers(dir)` / `listDiscoveryMcpServers(dir)`.

`snapshotSource()` (and therefore `GET /auth/me/llm-sources`) now reports `agentCount`/`hookCount`/`mcpCount` alongside `skillCount`. `GET /auth/me/llm-sources/<id>/discovery` returns the actual lists (not just counts) — `{ agents: [...], hooks: [...], mcpServers: [...] }` — for the Mac detail view.

## Safety — unchanged principle, explicitly reaffirmed for each new kind

The original design's core rule: **non-builtin sources are discovery-only.** That rule now has to hold for four kinds instead of one. Hooks and MCP servers are the two where getting this wrong would be a real security regression, since both exist specifically to *run something*.

- **Skills**: attachable as chat "/" menu context (unchanged) — never auto-invoked.
- **Agents**: catalogued (name + description) for display in the source's detail view. **Never wired to `ask-subagent` or any other invocation path.** A third-party source cannot make its "agent" definition actually runnable inside this app.
- **Hooks**: catalogued (event, matcher, truncated command string) for display only. **The command is never executed, by any source, including `builtin`.** A registered source's `hooks.json` is inert data as far as this server's runtime is concerned.
- **MCP servers**: catalogued (name, command, args) for display only. **This server never spawns or connects to a listed MCP server, for any source.** This is the highest-stakes of the four kinds — an MCP server isn't a one-shot command like a hook, it's a long-lived process with whatever capabilities its tools expose (filesystem, network, arbitrary code execution via its own tool-call surface). Auto-connecting to one from a source a user merely *registered* (which per this whole feature requires nothing more than a public git URL or a local path) would be worse than the hooks risk, not equivalent to it.

If hook execution or MCP connection is ever wanted, that is a distinct, much bigger feature requiring its own sandboxing/consent design (a real Claude Code session prompts the user before trusting a project's `.mcp.json`, for exactly this reason) — explicitly out of scope here. Only the `builtin` source may still contribute agent-*loadable* tools via `/kb/agent/catalog` — that path is completely untouched by this change.

## Files touched

Same file set as the original design's "Files touched" section, with `skills-sources` → `llm-sources` throughout, plus:

- `extension/llm-sources/registry.mjs` — `countDiscoveryAgents`/`listDiscoveryAgents`, `countDiscoveryHooks`/`listDiscoveryHooks`, `countDiscoveryMcpServers`/`listDiscoveryMcpServers`, `sourceDiscoveryDetail(id)`.
- `extension/server/auth-routes.mjs` — new `GET /auth/me/llm-sources/<id>/discovery` route.
- Mac: `LlmSourceInfo` gains `agentCount`/`hookCount`/`mcpCount`; new `LlmSourceAgent`/`LlmSourceHook`/`LlmSourceMcpServer`/`LlmSourceDiscoveryDetail` DTOs + `llmSourceDiscovery(id:)` client method; `LlmSourceRow` subtitle and `LlmSourceDetailView` gain the counts and listings for all three new kinds.

## Testing

- Server: `isValidLlmSource` accepts an agents-only, hooks-manifest-only, or `.mcp.json`-only directory (not just the original registry.yaml / plugin.json+skills/ markers); `countDiscoveryAgents`/`listDiscoveryAgents`, `countDiscoveryHooks`/`listDiscoveryHooks`, and `countDiscoveryMcpServers`/`listDiscoveryMcpServers` unit tests (including a malformed MCP-server entry missing `command` being skipped, not thrown); `sourceDiscoveryDetail` happy-path + unknown-id; HTTP-level test for the discovery route plus the renamed list/toggle/add/update/remove routes (all in `extension/tests/llm-sources-registry.test.mjs` and `extension/tests/auth-routes.test.mjs`).
- Mac: decode tests for `LlmSourceInfo` (with all three new count fields), `LlmSourceSummary`, and `LlmSourceDiscoveryDetail` (agents + hooks + mcpServers) in `LlmSourceDTOTests.swift`.

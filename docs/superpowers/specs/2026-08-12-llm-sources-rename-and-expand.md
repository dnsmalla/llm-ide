# LLM Sources — rename + multi-kind discovery

- **Date:** 2026-08-12
- **Status:** Implemented
- **Supersedes:** `docs/superpowers/specs/2026-08-11-skills-sources-design.md` (design/naming below; the server + Mac implementation plans it links stay as historical execution records and are not rewritten)
- **Scope:** Rename the "skills source" registry to "LLM source", and generalize what a registered source can contribute from skills-only to skills + agents + hooks.

## Why

The original feature (`docs/superpowers/plans/2026-08-11-skills-sources-server.md`, `...-mac.md`) shipped a registry of skill repos. The request driving this doc: rename it to something that doesn't imply "skills only," and let a registered source also surface subagent definitions and hooks it contains — "collect all LLM related source... if there exist I want collect in there" (user's framing). The system should become the single place a repo's LLM-relevant resources are catalogued, not just skills.

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

`SERVER_API_VERSION` bumped 26 → 27 (the endpoint paths themselves changed — a real HTTP-surface break for any existing client, per the bump convention documented in `server.mjs`).

**Scope expansion** — a registered source may now contribute three discoverable kinds instead of one:

1. **Skills** (unchanged) — `skills/`, `runtime/` families, `SKILL.md` frontmatter.
2. **Agents** (new) — `agents/*.md`, same frontmatter shape as `SKILL.md` (Claude Code's own convention for standalone subagent definitions). `countDiscoveryAgents(dir)` / `listDiscoveryAgents(dir)`.
3. **Hooks** (new) — `.claude-plugin/hooks/hooks.json` or a top-level `hooks/hooks.json` fallback, the Claude Code plugin-hook manifest shape (`{ "<Event>": [{ matcher?, hooks: [{type, command}] }] }`). `countDiscoveryHooks(dir)` / `listDiscoveryHooks(dir)`.

`snapshotSource()` (and therefore `GET /auth/me/llm-sources`) now reports `agentCount`/`hookCount` alongside `skillCount`. A new `GET /auth/me/llm-sources/<id>/discovery` endpoint returns the actual list (not just counts) — `{ agents: [...], hooks: [...] }` — for the Mac detail view.

## Safety — unchanged principle, explicitly reaffirmed for the two new kinds

The original design's core rule: **non-builtin sources are discovery-only.** That rule now has to hold for three kinds instead of one, and it's easiest to get wrong for hooks specifically, since a hook's whole point is "run this command when X happens."

- **Skills**: attachable as chat "/" menu context (unchanged) — never auto-invoked.
- **Agents**: catalogued (name + description) for display in the source's detail view. **Never wired to `ask-subagent` or any other invocation path.** A third-party source cannot make its "agent" definition actually runnable inside this app.
- **Hooks**: catalogued (event, matcher, truncated command string) for display only. **The command is never executed, by any source, including `builtin`.** This is the one that would be a genuine security regression if gotten wrong — a registered source's `hooks.json` is inert data as far as this server's runtime is concerned. If hook execution is ever wanted, that is a distinct, much bigger feature requiring its own sandboxing/consent design — explicitly out of scope here.

Only the `builtin` source may still contribute agent-*loadable* tools via `/kb/agent/catalog` — that path is completely untouched by this change.

## Files touched

Same file set as the original design's "Files touched" section, with `skills-sources` → `llm-sources` throughout, plus:

- `extension/llm-sources/registry.mjs` — `countDiscoveryAgents`/`listDiscoveryAgents`, `countDiscoveryHooks`/`listDiscoveryHooks`, `sourceDiscoveryDetail(id)`.
- `extension/server/auth-routes.mjs` — new `GET /auth/me/llm-sources/<id>/discovery` route.
- Mac: `LlmSourceInfo` gains `agentCount`/`hookCount`; new `LlmSourceAgent`/`LlmSourceHook`/`LlmSourceDiscoveryDetail` DTOs + `llmSourceDiscovery(id:)` client method; `LlmSourceRow` subtitle and `LlmSourceDetailView` gain agent/hook counts and listings.

## Testing

- Server: `isValidLlmSource` accepts an agents-only or hooks-manifest-only directory (not just the original registry.yaml / plugin.json+skills/ markers); `countDiscoveryAgents`/`listDiscoveryAgents` and `countDiscoveryHooks`/`listDiscoveryHooks` unit tests; `sourceDiscoveryDetail` happy-path + unknown-id; HTTP-level test for the new discovery route plus the renamed list/toggle/add/update/remove routes (all in `extension/tests/llm-sources-registry.test.mjs` and `extension/tests/auth-routes.test.mjs`).
- Mac: decode tests for `LlmSourceInfo` (with the two new count fields), `LlmSourceSummary`, and `LlmSourceDiscoveryDetail` in `LlmSourceDTOTests.swift`.

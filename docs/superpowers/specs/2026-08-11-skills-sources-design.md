# Skills Sources — Central Skills Management Surface

- **Date:** 2026-08-11
- **Status:** Implemented (server: `docs/superpowers/plans/2026-08-11-skills-sources-server.md`; Mac: `docs/superpowers/plans/2026-08-12-skills-sources-mac.md`)
- **Scope:** Surface central (and third-party) skills repos as a manageable "skills source" kind in the Mac Library → Plugins section.

## Problem

Today, skills reach LLM-IDE through three disconnected surfaces:

1. **Chat "/" menu discovery** (`GET /kb/agent/skill-library`) — reads the single resolved central `.skills` repo, returns the `skills/` + `runtime/` families as attach-as-context entries the agent cannot invoke.
2. **Loadable agent tools** (`GET /kb/agent/catalog`) — the `agent-globals` + `agent-tools` families the agent can invoke.
3. **External-CLI project flow** (`POST /kb/project/install-skills` + Mac `ProjectSkillsInstaller`) — copies/symlinks `.skills` into a project for Claude/Cursor/Codex/Gemini.

There is no single place to see, enable/disable, install, or update skills, and only one skills repo (the pinned `.skills` submodule) is supported. Users who maintain skills across multiple repos cannot register or manage them separately.

## Goals

- **Single management surface.** Each skills repo appears as its own row in Library → Plugins, manageable (see / enable-disable / install / update / remove) independently.
- **Multi-repo.** Skills can come from different repos (bundled `.skills`, personal/team git repos, marketplace), each maintained separately.
- **Discovery-only, read-in-place.** Skills sources surface skills in the chat "/" menu as context entries (as today); they are **not** loaded as agent tools. No on-disk duplication of the kit.
- **Per-repo enable/disable.** Disabling a source hides its discovery skills from the chat "/" menu.

## Non-goals (explicitly unchanged)

- The agent **loading** path (`/kb/agent/catalog`) — unchanged.
- The **external-CLI project flow** (`install-project-skills.mjs` / `ProjectSkillsInstaller`) — unchanged.
- The existing **markdown plugin system** — untouched. A "skills source" is a distinct kind, not a plugin subtype.

## Concept

A **skills source** is a registered skills repo. It is a distinct entry kind in Library → Plugins (badged "skills source"), parallel to but separate from markdown plugins. Each source is discovery-only and read in place.

The bundled `.skills` submodule is the default `builtin` source. Additional sources can be registered from a Git URL (MVP) or a local path / marketplace entry (phase 2).

## Data model

```
SkillsSource {
  id: string            // stable slug, e.g. "builtin", "gridpredict-skills"
  name: string          // display name
  origin: 'builtin' | 'git' | 'marketplace' | 'local'
  location: string      // resolved absolute path (in-place read) or clone URL
  ref?: string          // git: pinned branch/tag/sha
  version?: string      // from registry.yaml / .claude-plugin/plugin.json if present
  builtin: boolean      // true for bundled .skills — not removable, not renameable
}
```

- **Registry (system-wide, server-owned):** `~/Library/Application Support/llm-ide/skills-sources.json` — the list of registered sources. Seeded on first run with one entry: `{ id: "builtin", origin: "builtin", builtin: true, location: <resolveCentralSkillsRepo()> }`.
- **Per-user enable state:** `~/Library/Application Support/llm-ide/skills-sources-state.json`, shape `{ [userId]: { enabled: [sourceId…] } }`. The `builtin` source defaults **enabled** (preserves today's behavior).
- **Cloned sources** (git/marketplace) live under `~/Library/Application Support/llm-ide/skills-sources/<id>/`, siblings to `plugins/`. The bundled `.skills` is referenced in place from the repo submodule — never copied.

**Validity:** a directory is a valid skills source if it contains `registry.yaml` **or** (`.claude-plugin/plugin.json` + a `skills/` directory). The reader prefers `registry.yaml`; otherwise it scans `skills/**/SKILL.md`.

## Delivery to the chat "/" menu

Generalize `listSkillLibrary()` in `extension/llm_agent/skills/skill-library.mjs` to iterate all **enabled** sources instead of one resolved repo:

- For each enabled source, read its discovery families (`skills/` + `runtime`), via `registry.yaml` (fallback: directory scan). Union into one catalog.
- Each returned skill is tagged with `sourceId` and `sourceName`.
- Disabled sources contribute nothing. All-disabled → empty catalog.
- The in-memory `_cache` is invalidated on any add / update / remove / toggle.

Loadable agent tools (`agent-globals` + `agent-tools` via `/kb/agent/catalog`) remain sourced from the `builtin` source only (see Safety).

## HTTP surface

New routes in `extension/server/auth-routes.mjs`, parallel to the plugin routes. Admin-gated writes; every mutation audited via `safeAudit` with `action: 'skills-source.*'`; every mutation busts the skill-library cache in-process (no server restart).

| Method | Endpoint | Body / Query | Purpose |
|---|---|---|---|
| GET | `/auth/me/skills-sources` | — | List registered sources + per-user enable state + per-source skill counts |
| POST | `/auth/me/skills-sources/add` | `{url\|path, ref?, name?}` | Validate, clone/register a new source; returns the new source |
| POST | `/auth/me/skills-sources/toggle` | `{id, enabled}` | Per-user enable/disable |
| POST | `/auth/me/skills-sources/update` | `{id}` | Re-sync: git → `fetch` + checkout `ref`; builtin → `git submodule update --init .skills`; bust cache |
| DELETE | `/auth/me/skills-sources/<id>` | — | Remove source + delete its clone dir; rejected for `builtin` |

Per the "Where to Add X" invariant: register these paths in the `ENDPOINTS` array and bump `SERVER_API_VERSION` in `extension/server.mjs`.

## Mac UI

- New `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+SkillsSources.swift` — DTOs (`SkillsSource`, `SkillsSourcesListResponse`) + methods mirroring the endpoints.
- Library → Plugins gains a **"Skills Sources" sub-section**, visually distinct from markdown plugins. Each row shows: name, origin badge (builtin / git / marketplace / local), skill count, version, an enable toggle, and actions — **Update**, **Reveal** (open the source dir in Finder), **Remove**. The `builtin` row shows **Install** instead of Remove when the submodule is not checked out.
- An **"Add skills source…"** sheet offers: Git URL (reusing `PluginGitInstaller.normalize()` for validation and the shallow-clone path) or a local path. (Marketplace import is phase 2.)
- The chat "/" menu labels each discovery skill with its source name.

## Safety

- **Untrusted sources are discovery-only.** Only the `builtin` source may contribute agent-*loadable* tools (`/kb/agent/catalog`). Third-party sources contribute chat-menu discovery skills only; they cannot inject executable tool handlers (the agent `handlers` map is hardcoded in `route.mjs`, so this is parity, not a new attack surface).
- **Read in place, no copy/drift.** Git/marketplace clones live in the managed dir; nothing is duplicated into `plugins/`. The `builtin` source always reflects the current submodule checkout.
- **URL hardening** reuses `PluginGitInstaller.normalize()` (`mac/Sources/LlmIdeMac/Services/PluginGitInstaller.swift`): reject `file://`, `ssh://`, localhost/`.local`, non-https; arg-injection `--` guard; `GIT_TERMINAL_PROMPT=0`; detached stdin; concurrent pipe drain. The server-side add path mirrors these checks.
- **Builtin protections:** the `builtin` source cannot be removed or renamed. It can be disabled (hides `.skills` discovery skills), re-installed (submodule init), and updated (submodule sync).

## Resolved detail — "Update" semantics

Update re-syncs a source to its currently tracked ref/SHA and re-reads:

- **Git/marketplace:** `git fetch` + checkout the tracked `ref` (advances a branch ref to latest; a pinned sha stays put unless the pin is changed).
- **Builtin:** `git submodule update --init .skills` (recover the pinned checkout) — does **not** bump the submodule pointer.
- Bumping the `.skills` submodule *pin* remains a dev/git action, not a Library button.

## Phasing

- **MVP:** registry + per-user toggle gating the chat menu + `builtin` row + Git-URL add/update/remove + Library UI + chat-menu source labels.
- **Phase 2:** marketplace import + local-path source (reuses existing Claude import sheet patterns).

## Files touched

**Server:**
- `extension/llm_agent/skills/skill-library.mjs` — multi-source iteration + per-source tagging + cache-invalidation hook.
- `extension/server/auth-routes.mjs` — five new endpoints.
- `extension/server.mjs` — `ENDPOINTS` + `SERVER_API_VERSION` bump.
- new `extension/skills-sources/registry.mjs` — source registry CRUD + clone/update + validation (sibling to `extension/plugins/`).

**Mac:**
- new `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+SkillsSources.swift`.
- `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift` — Skills Sources sub-section + Add sheet.
- new row/detail views (reuse `PluginLibraryRow` / `PluginDetailView` patterns, or new `SkillsSourceRow`).

## Testing

**Server:**
- Registry CRUD; `builtin` not removable; URL validation rejects bad schemes; clone/update/remove happy paths.
- `listSkillLibrary()` returns the union across multiple enabled sources; hides disabled sources; empty when all disabled.
- Cache invalidation on add/update/remove/toggle.
- Per-user isolation of enable state.

**Mac:**
- Rows render with correct badges/counts; toggle calls the endpoint and reflects in the chat menu; Add sheet validates URL; Update flow; `builtin` Install/Update.

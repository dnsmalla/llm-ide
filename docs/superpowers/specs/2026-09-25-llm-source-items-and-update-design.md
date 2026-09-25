# LLM sources: per-item selection + update-and-repair (design)

**Date:** 2026-09-25 · **Status:** approved · **Branch:** `feat/llm-source-items`

## Goal

In the Mac app's Library → LLM Sources, let the user (1) check/uncheck
individual skills, agents, commands, and templates of **every** source
(Central Skills included), and (2) see when a source has changed upstream and
press **Update**, which pulls it and corrects every file that depends on it.

## Decisions

| Question | Decision |
|---|---|
| Which sources get item selection | All, including Central Skills (builtin) |
| Item kinds | skill, agent, command, template. Hooks and MCP stay whole-source (they have their own trust/consent gates) |
| Scope of an unchecked item | Everywhere: chat "/" menu, phone, Loop, Doc Gen/Visual menus, AND project installs (`.claude/skills`, `.cursor`, `.codex`, `.agents`, `.gemini`, and linked command/agent files) |
| New items from an update | Checked by default, flagged **New**; user's unchecks persist across updates |
| Update button | Detect upstream change → badge → Update pulls + repairs related files |

## Storage

`llm-sources-state.json` user entry gains `disabledItems`:

```json
{ "user-1": { "enabled": ["builtin"],
              "disabledItems": { "builtin": ["skill:excel-io", "command:slides"] } } }
```

Keys are `<kind>:<frontmatter name>` — the name the discovery listing shows.
Storing the **unchecked** set is what makes new items default to checked. Every
writer of a user entry preserves both fields. Removing a source drops its
`disabledItems`; an update drops keys for items that no longer exist.

Registry entry gains `lastUpdate: { at, fromRev, toRev, added: [key], removed: [key] }`;
`added` drives the **New** badge until the next update.

## Server

- `state.mjs`: `listDisabledItems(userId, sourceId)`, `isItemEnabled(...)`,
  `setItemsEnabled(userId, sourceId, kind, names[], enabled)`, `pruneMissingItems(sourceId, presentKeys)`.
- `POST /auth/me/llm-sources/items` `{ sourceId, kind, names: string[], enabled }` — per user, not admin.
- Discovery (`GET …/<id>/discovery`) items gain `enabled` and `isNew`; list rows gain `disabledItemCount`.
- Consumers filter unchecked items: `listSkillLibrary` (skills), `listGenerationLibrary` (commands, templates).
  Source agents are catalogued only (no runtime consumes them yet) — their selection is stored and shown, and the UI says so.
- `GET /auth/me/llm-sources/updates[?force=1]` → per source `{ id, status, localRev, remoteRev, checkedAt, message? }`,
  `status ∈ update-available | up-to-date | local | diverged | unknown`; cached 30 min per source.
  - git source: `rev-parse HEAD` vs `ls-remote origin <ref>`.
  - builtin: `fetch origin main`, then fast-forward check (`merge-base --is-ancestor HEAD FETCH_HEAD`); ahead/diverged → `diverged`.
  - local: `local` (no remote; the button is **Rescan**).
  - Any git/network error → `unknown` (never an error response).
- `POST …/update` (admin) now: refuse on uncommitted changes; git source `fetch --depth 1 origin <ref>` + `reset --hard FETCH_HEAD`
  (fixes stale `checkout <ref>` on shallow clones); builtin `fetch origin main` + `merge --ff-only FETCH_HEAD`
  (refuses non-fast-forward — never drops local commits), then, when the kit is this checkout's `.skills`
  submodule, run `scripts/sync-skills.sh` (writes `.skills-lock`, re-syncs agent-tool defs). Diff items
  before/after, record `lastUpdate`, prune missing keys, reset caches. Response:
  `{ ok, fromRev, toRev, added: [{kind,name}], removed: [{kind,name}], corrected: [string] }`.
- `POST /kb/project/install-skills` passes the user's unchecked builtin skill/command/agent names to the kit's
  `install.sh --exclude a,b,…`.
- `SERVER_API_VERSION` 55 → 56.

## Kit (`.skills/scripts/install.sh`)

`--exclude "n1,n2"`: excluded skill ids are not linked (and `--prune` removes their existing links).
For the whole-dir config links (`config/tool/<tool>/{commands,agents}`), when an excluded name matches a
file stem in that dir, the dir is installed as a real directory of per-file links minus the excluded
ones; a previously per-file-managed directory (only kit-pointing symlinks inside) is replaced freely when
switching back. `test-install.sh` covers both.

## Mac

- API: `setLlmSourceItems`, `llmSourceUpdates(force:)`, `updateLlmSource` returns `LlmSourceUpdateResult`;
  discovery items decode optional `enabled` (default true) / `isNew` (default false); `LlmSourceInfo.disabledItemCount` (default 0).
- Detail view: a checkbox per skill/agent/command/template row, **New** badge, "All / None" per section;
  update status line and **Update** / **Rescan** / **Check for updates** buttons; after an update, the
  active project's skills are re-installed and a summary is shown (added, removed, corrected files).
  Toggling a Central Skills item re-installs the active project's skills (debounced) so "everywhere" holds.
- Sidebar: "Update" badge on rows with `update-available`; "+" menu gains **Check for updates**; subtitle
  shows "(N off)". A `.llmSourcesChanged` notification refreshes the sidebar (fixing the documented
  refresh gap) and invalidates the chat "/" menu cache.

## Testing

Node: state round-trip + preservation; library/generation filtering; install `--exclude` pass-through;
update detection against a local bare repo; stale-clone fix; builtin ff-only refusal; dirty refusal;
added/removed diff + prune. Kit: `test-install.sh` exclude cases. Mac: DTO decode (new + old shapes),
summary formatting; `swift build`; `LLMIDE_KEYCHAIN_BACKEND=memory swift test`.

# LLM Source Items + Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-item selection for every LLM source and an Update button that detects upstream changes, pulls them, and repairs dependent files.

**Architecture:** Per-user unchecked-item set in `llm-sources/state.mjs`, honoured by every consumer (skill library, generation library, kit installer via `--exclude`). Registry gains update detection + a safe update (reset/ff-only, dirty refusal) that diffs items and runs the builtin sync. Mac detail view gets checkboxes, badges, and an update flow that re-installs the active project's skills.

**Tech Stack:** Node 20 ESM + `node --test`; bash/python kit installer; SwiftUI + XCTest.

**Spec:** `docs/superpowers/specs/2026-09-25-llm-source-items-and-update-design.md`

## Global Constraints

- Item keys: `<kind>:<name>`, kinds `skill | agent | command | template`; names validated `^[A-Za-z0-9._-]{1,80}$`.
- Unchecked set stored; absent = checked. Every state writer preserves `enabled` AND `disabledItems`.
- Update never discards local work: dirty tree → refuse; builtin non-fast-forward → refuse.
- Update detection never errors the request; failures → `status: "unknown"`.
- `SERVER_API_VERSION` 55 → 56 with a changelog comment.
- Mac: new DTO fields decode with defaults (older server keeps working). Tests with `LLMIDE_KEYCHAIN_BACKEND=memory`.
- Commit per task; Conventional Commits with Japanese subject (repo style).

---

### Task 1: Item state (`extension/llm-sources/state.mjs`)
**Files:** Modify `extension/llm-sources/state.mjs`; Test `extension/tests/llm-sources-state.test.mjs`.
**Produces:** `itemKey(kind,name)`, `listDisabledItems(userId, sourceId): Set<string>`, `isItemEnabled(userId, sourceId, kind, name): boolean`, `setItemsEnabled(userId, sourceId, kind, names, enabled): Set<string>`, `pruneMissingItems(sourceId, presentKeys: Set<string>)`, `ITEM_KINDS`.
- [ ] Tests: default enabled; uncheck/recheck round-trip; per user isolation; `setEnabled` preserves `disabledItems` and vice-versa; `pruneOrphans` drops removed sources' `disabledItems` and keeps entries that still hold items; `pruneMissingItems` removes stale keys.
- [ ] Implement; run `node --test tests/llm-sources-state.test.mjs`; commit.

### Task 2: Consumers filter unchecked items
**Files:** Modify `extension/llm_agent/skills/skill-library.mjs`, `extension/llm_agent/skills/generation-library.mjs`, `extension/llm-sources/registry.mjs` (`sourceDiscoveryDetail(id, userId)` adds `enabled`/`isNew`; `listSourcesWithState` adds `disabledItemCount`); Tests `skill-library.test.mjs`, `generation-library.test.mjs`, `llm-sources-registry.test.mjs`.
- [ ] Tests: unchecked skill absent from `listSkillLibrary(user)`; unchecked command/template absent from `listGenerationLibrary(user)`; discovery marks `enabled:false`; `isNew` from `lastUpdate.added`.
- [ ] Implement; run the three files; commit.

### Task 3: Items endpoint + install exclusion pass-through
**Files:** Modify `extension/server/auth-routes.mjs` (`POST /auth/me/llm-sources/items`, discovery passes userId), `extension/kb/install-project-skills.mjs` (`exclude` option → `--exclude`), `extension/routes/router.mjs` (compute builtin exclusions from `req userId`), `extension/server.mjs` (version 56 + comment); Tests `install-project-skills.test.mjs`, route test in `llm-sources-registry.test.mjs` or a new `llm-sources-items-route.test.mjs`.
- [ ] Tests: `installProjectSkills({exclude})` passes validated names (rejects unsafe names); route validates kind/names/sourceId and resets caches.
- [ ] Implement; run; commit.

### Task 4: Kit `install.sh --exclude` (in `.skills`, branch `feat/app-forge`)
**Files:** Modify `.skills/scripts/install.sh`, `.skills/scripts/test-install.sh`, `.skills/CHANGELOG.md`.
- [ ] Tests (test-install.sh): excluded skill not linked; previously linked excluded skill pruned; excluded command file absent while siblings linked per-file; clearing the exclude restores the whole-dir link.
- [ ] Implement; run kit gates; commit in kit.

### Task 5: Update detection + safe update (`registry.mjs`)
**Files:** Modify `extension/llm-sources/registry.mjs` (`checkSourceUpdate`, `checkAllUpdates`, `updateSource` rewrite, `itemKeysOf`), `extension/server/auth-routes.mjs` (`GET …/updates`, update response); Test `extension/tests/llm-sources-update.test.mjs` (real git against a local bare repo in tmp).
- [ ] Tests: up-to-date vs update-available for a git source; update moves a shallow clone to the new commit (stale-checkout regression); dirty clone refused; builtin ff-only update succeeds and records added/removed; builtin with a local-only commit → `diverged` and update refused; local source → `local`; git failure → `unknown`; removed items pruned from users' unchecked sets.
- [ ] Implement; run; commit.

### Task 6: Mac API + DTOs
**Files:** Modify `mac/Sources/LlmIdeMac/Core/Networking/API/LlmIdeAPIClient+LlmSources.swift`, `mac/Sources/LlmIdeMac/Services/NotificationNames.swift` (`.llmSourcesChanged`); Test `mac/Tests/LlmIdeMacTests/LlmSourceDTOTests.swift`.
- [ ] Tests: discovery items decode `enabled`/`isNew` and default when absent; update result decode; updates list decode; `disabledItemCount` default 0; `LlmSourceUpdateResult.summary(projectName:)` text.
- [ ] Implement; commit.

### Task 7: Mac UI
**Files:** Modify `Features/Library/Views/LlmSourceDetailView.swift`, `LlmSourceRow.swift`, `LibraryView.swift`, `Core/Editor/CompletionController.swift`.
- [ ] Checkboxes + New badge + All/None; status line + Update/Rescan/Check buttons; post-update project reinstall + summary; builtin item toggle → debounced project reinstall; sidebar badge + "Check for updates" + "(N off)"; `.llmSourcesChanged` observers.
- [ ] `swift build`; `LLMIDE_KEYCHAIN_BACKEND=memory swift test`; commit.

### Task 8: Verify end to end + finish
- [ ] Full `cd extension && npm test` (compare against main baseline), `npm run lint`; `make regression`-equivalent gates that apply (`mac/Scripts/feature-boundaries.sh`).
- [ ] Live check: start the server on a scratch data dir, uncheck a builtin skill via the endpoint, confirm it leaves `/kb/agent/skill-library` and the project's `.claude/skills`; `GET …/updates` returns statuses.
- [ ] Bump `.skills` gitlink + `.skills-lock` for the kit change; docs (`docs/spec` LLM sources section if present); commit.

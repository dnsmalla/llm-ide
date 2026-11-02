# Parity inventory (Swift labels vs desktop code)

Generated 2026-11-02 by `node scripts/parity-inventory.mjs <area> --md` (test: `desktop/scripts/parity-inventory.test.mjs`).
It lists every user-visible literal in the Mac's SwiftUI views (buttons, menus, toggles, fields, section titles,
tooltips, alerts, accessibility text, static text, shortcuts) and checks whether the same text exists in the
matching desktop source. **A miss is a worklist item, not always a bug:** it can be a Mac-only feature (the
git/PR/issue sheets inside Chat, Loop worktrees, Sparkle), a reworded label, or text built at runtime. A hit
proves the label exists, not that it behaves like the Mac. Regenerate after parity work and compare the counts.

| area | Swift labels | exact in desktop | only inside a longer sentence | missing |
|---|---|---|---|---|
| [explorer](explorer.md) | 107 | 35 | 6 | 66 |
| [chat](chat.md) | 253 | 53 | 6 | 194 |
| [library](library.md) | 88 | 27 | 1 | 60 |
| [extensions](extensions.md) | 204 | 50 | 8 | 146 |
| [docgen](docgen.md) | 65 | 23 | 4 | 38 |
| [graph](graph.md) | 26 | 9 | 4 | 13 |
| [issues](issues.md) | 71 | 18 | 3 | 50 |
| [loop](loop.md) | 177 | 35 | 7 | 135 |
| [autotask](autotask.md) | 102 | 30 | 4 | 68 |
| [settings](settings.md) | 186 | 76 | 10 | 100 |
| [shell](shell.md) | 77 | 29 | 4 | 44 |

## Verified triage, all areas (2026-11-02)

Every missing label was classified by a Haiku pass and then re-checked by an Opus pass that read the Swift, grepped the
desktop with synonyms, and opened the cited desktop line for at least 40% of the "reworded" claims. Per-area detail
(feature tables, every reclassification, implementation batches): `*-triage.md` in this folder.

| area | labels | real gap | reworded | Mac-only | decoration | dead on the Mac | gap features |
|---|---|---|---|---|---|---|---|
| chat | 194 | 51 | 52 | 19 | 7 | 65 | 21 |
| loop | 137 | 75 | 51 | 2 | 8 | 1 | 28 |
| autotask | 68 | 56 | 8 | 1 | 2 | 1 | 12 |
| extensions | 152 | 90 | 48 | 0 | 14 | 0 | 19 |
| settings | 100 | 23 | 48 | 22 | 7 | 0 | 15 |
| explorer | 66 | 36 | 23 | 3 | 4 | 0 | 12 |
| library | 60 | 12 | 32 | 6 | 10 | 0 | 8 |
| issues | 50 | 30 | 17 | 0 | 3 | 0 | 14 |
| shell | 44 | 11 | 26 | 6 | 1 | 0 | 6 |
| docgen + graph | 51 | 13 | 29 | 3 | 6 | 0 | 8 |
| **total** | **922** | **397** | **334** | **62** | **62** | **67** | **143** |

(Rows are labels per site; a text used at several sites can appear more than once.)

### Bugs found in code the desktop already ships (fix before adding features)

1. **Auto Tasks:** 7 of the Mac's structural tasks (deterministic code on the Mac) are sent to the agent as invented
   language-model prompts, so an agent improvises them and may edit files. Disable them until they are real.
2. **Loop:** scope globs are saved but never enforced (`protected.ts:27-33`); one save after a parse error wipes every stored
   custom recipe; a skill stage passes when the skill never ran (`NativeLoopScreen.tsx:366`); opening a past run hides the live
   log for good; run records never save `changedPaths` or `summaryPath`; the revert runs `git checkout --`, which discards the
   user's own uncommitted edits in those files.
3. **Shell:** the sign-out dialog text is wrong ("forget this device" removes saved repositories but keeps the GitHub and
   GitLab tokens); there is no minimum-API check when a source-checkout or adopted core is older than the app.
4. **Stale docs:** `plans/2026-10-31-settings-mirror-map.md` lines 35 and 73 (the Agent SDK card does have a restart
   button), `notices.ts:63`, `ServerSection.tsx:15`, the `regression.ts:3` comment (the judge and repair do exist).

### Decisions needed before the held items can be built

- **Provider writes** (issue create/edit/comment/close, kanban drag, PR/MR, branch, Review code-change workflow, plan
  Merge and Push): new core routes, token in the core vault, desktop confirm before every remote write. Order proposed:
  read-only paging, milestone, assignee and comments first; then comment, close or reopen, drag, edit, create.
- **Source Control commands** needing Rust (stash, amend, merge, branch delete, tag create, push, pull, publish,
  Discard All) and who holds the git credential.
- **Plugin and MCP install paths** (Claude/Codex import, zip install and replace, marketplace, MCP add, credential save,
  update and Re-sync): all execute or register code, so they go through the consent flow; non-GitHub installs and the
  marketplace as a catalog index source are product decisions.
- **Credentials and data:** Library file remove (trash only, never the Mac's permanent delete), "disconnect all accounts"
  (deletes tokens), Anthropic/Jev/SerpAPI key entry, project export, where the Library "Remove from List" tombstone lives.
- **Loop:** refactor batches need a host rollback; bulk approve; Python environment setup; run-changes commit limited to the
  run's paths; worktrees; merge requests. Shell stages cannot start on Windows (the host always launches `/bin/sh`).
- **Mac-only by architecture** (not planned): menu-bar quick chat, Sparkle updates, Mobile Control, Self-Heal, 3D graph,
  AX auto-capture and unfinished-recording recovery (both wait on desktop Live), legacy-meetings export.
- **Never mirrored:** the 65 labels dead on the Mac (Chat issue, PR, branch, git-op and update-file sheets).

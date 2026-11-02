# Auto Tasks parity triage (verified)

Date: 2026-11-02. Input: 68 Mac labels from `mac/Sources/LlmIdeMac/Features/AutoTask/` that the parity inventory did not find in the desktop code (102 unique labels, 34 found). First pass by Haiku (`g09-out.json`), checked here label by label by an Opus pass, read-only. Per-label result: scratchpad `triage/autotask-verified.json` (same schema plus `verifiedBy` and `changed`).

Desktop reference: the live Auto Tasks screen is `ui/screens/autotasks/native/NativeAutoTasksScreen.tsx` (`ui/screens/autotasks/index.tsx` exports it). The older bridge screen `ui/screens/autotasks/AutoTasksScreen.tsx` is not wired, and nothing in it counts as parity evidence.

Mac reachability: `AutoCodeView` is built by `FeatureCatalog.autoTasksPane` (`Shell/FeatureCatalog.swift:591`, under `#if FEATURE_AUTOTASK`), which `Shell/AppShell.swift:772` calls. Every sub-view is created from `AutoCodeView` (`ModelLimitsPanel` :538, `AddCustomAutoTaskSheet` :557, `CronField` :641, `AutoTaskSettingsSection` :654/:768, `AutoTaskTemplateSection` :659/:773, `CustomTaskScheduleSection` :757; `LibraryFolderPicker` from `AutoTaskSettingsSection.swift:60`). All of them run in a shipped build that has `auto_tasks`. I found one dead branch inside them (see the reclassifications).

## Counts

| Class | Haiku | Verified |
|---|---|---|
| REAL_GAP | 49 | 56 |
| REWORDED | 8 | 8 |
| RUNTIME | 10 | 2 |
| MAC_ONLY | 1 | 1 |
| DEAD_ON_MAC | 0 | 1 |

17 labels changed class and one more changed effort. How the 17 break down:
- **Substantive overturns: 11.**
  - 5 REAL_GAP labels were wrong: 4 already exist on the desktop and 1 is dead on the Mac.
  - 4 REWORDED labels were wrong: the desktop control is missing or does something different.
  - 2 RUNTIME labels were wrong: each hides a real gap.
- **Bookkeeping: 6.** These are placeholders or runtime fragments of a sheet that is entirely absent. They are folded into that sheet's gap, because RUNTIME applies only when the host view exists on the desktop.

The REAL_GAP count went up rather than down. Unlike Chat, Auto Tasks has no unreachable transport: the views are live.

## Reclassifications

| # | Label | Haiku | Verified | Reason |
|---|---|---|---|---|
| 21 | Configuration | REAL_GAP | REWORDED | Header of the regression knobs. On the desktop these live in the Loop stage editor; audit T2 merges regression into Loop |
| 22 | Attempt repair on regression | REAL_GAP | REWORDED | Loop stage "Allows repair", `NativeLoopScreen.tsx:799` |
| 24 | Verify timeout (s) | REAL_GAP | REWORDED | Loop stage "Timeout (seconds)", `NativeLoopScreen.tsx:812`, passed to `loop_run_fault_verify` (:336) |
| 39 | Schedule active | REAL_GAP | REWORDED | This is the accessibility label of the Mac switch that arms cron (`CronField.swift:105`). The desktop "Run on schedule" checkbox does the same (`NativeAutoTasksScreen.tsx:192`). Haiku's "background scheduler" is a real gap, but it is not this label (see Batch C) |
| 32 | This task has no prompt of its own | REAL_GAP | DEAD_ON_MAC | The `ownPrompt == nil` branch of `AutoTaskTemplateSection` never renders: both callers pass a prompt (`AutoCodeView.swift:659` inside `if let ownPrompt`, and :773 with a non-nil Binding) |
| 15 | Reset to Default | REWORDED | REAL_GAP | This is the confirm button. The desktop "Restore Default" (`NativeAutoTasksScreen.tsx:181`) overwrites the prompt at once, with no confirmation |
| 14 | "…template to default?" | RUNTIME | REAL_GAP | Title of that missing confirmation dialog |
| 27 | (not installed) | REWORDED | REAL_GAP | The desktop keeps the stale skill row (:177) but does not mark it, so the user cannot tell the skill is gone |
| 41, 43 | Manual only — use ▶ Run / invalid | REWORDED | REAL_GAP | These are in `CustomTaskScheduleSection`, which exists only in the custom-task editor (`AutoCodeView.swift:757`). Folded into custom tasks |
| 25 | Nothing to configure — see the description above. | RUNTIME | REAL_GAP | Exposes a semantic gap: see "structural tasks" |
| 1, 5, 42 | Custom-task placeholders | RUNTIME | REAL_GAP (folded) | Belong to the missing custom-task sheet and section |
| 37 | Template-name placeholder | RUNTIME | REAL_GAP (folded) | Belongs to the missing New Template sheet |
| 60, 62 | updated / · resets | RUNTIME | REAL_GAP (folded) | Fragments of the missing API rate-limit section |
| 18 | Effective prompt hint | REAL_GAP M | REAL_GAP S | The desktop already builds the prompt inline in `runTask` (:99-101). Extracting that code and showing the result is small |

Confirmed unchanged:
- **MAC_ONLY "Push current state to a paired iPhone now".** It renders only when `mobileSync` is compiled in (`AutoCodeView.swift:112`). The desktop does not host `:3006` (MASTER-PLAN Phase 5).
- **RUNTIME `))s` and `cron`.** Duration text and a placeholder; their host controls exist on the desktop.
- **REWORDED.** I opened every REWORDED citation (8 of 8, not the minimum 40%); 4 were overturned (above) and 4 confirmed:
  - "No linked repository…": `NativeAutoTasksScreen.tsx:133`, same warning with an Open Settings link.
  - "No enabled tasks…": `NativeAutoTasksScreen.tsx:154`, same empty-filter state.
  - "No runs recorded yet…": `NativeAutoTasksScreen.tsx:157`. The desktop row does not show the trigger (manual or scheduled) and does not reveal the log file. Both are minor.
  - "Log · live": `NativeAutoTasksScreen.tsx:186`.

## Merged feature table

| Feature (Mac view) | Class | Labels | Evidence | What is missing | Needs | Effort | Risky | Safe now |
|---|---|---|---|---|---|---|---|---|
| Custom tasks (AddCustomAutoTaskSheet, custom row and Implement badge, CustomTaskScheduleSection, empty right pane) | REAL_GAP | 13 | `TASKS` is a fixed list (`model.ts:27-38`). The Mac plus button is always shown (`AutoCodeView.swift:106`) | Create, rename, enable, delete and run user tasks with a name, Review or Implement mode, optional cron and a prompt. Implement mode works on a `fix/custom-*` branch in a worktree | ui (Review mode); rust/git (Implement) | M / L | yes | HOLD |
| Prompt template library (AutoTaskTemplateSection) | REAL_GAP + 1 DEAD | 9 + 1 | Desktop "New…" only shows a notice (:181) | Named templates in `templates/auto_task/*.md`: picker, New, Rename, Duplicate, Delete, Unsaved/Revert, missing marker, and the SHA-256 approval gate for files changed outside the app | ui + host fs writes + approval-record store | L | yes | HOLD |
| Model & Limits panel (ModelLimitsPanel, minus the subscription section) | REAL_GAP | 18 | Desktop button only shows a notice (:156). Core routes exist: GET/PUT `/kb/usage/limits`, GET `/kb/usage/summary`, GET `/kb/usage/ratelimits`, GET `/kb/usage/resolve` (`extension/routes/router.mjs:1022-1063`). Nothing in `ui/` calls them | Per-provider model chain editor (priority up/down, enable, runs or tokens cap, daily or monthly window, switch-at %), usage meters, API rate-limit buckets, Refresh. The desktop runner also never calls `/kb/usage/resolve` before `/kb/loop/agent-run`, which already accepts `model` (`extension/routes/loop-agent.mjs:123`), so a cap set in the panel would not apply to desktop runs | ui + small runner change | M | no | yes (Batch B) |
| Claude subscription usage | REAL_GAP | 3 | `ClaudeLink/ClaudeSubscriptionUsageClient.swift` reads the Claude Code OAuth token (Keychain item "Claude Code-credentials", or a file fallback) and calls `api.anthropic.com/api/oauth/usage` | The whole section | rust (keychain + HTTPS) | M | yes (secrets) | HOLD |
| Action-item status list | REAL_GAP | 2 | Mac `ProcessedActionsRegistry` is a Mac-local JSON file filled by the native Sources→Issue and Implement Issues code. The desktop shows a fixed placeholder (:158). There is no core store, and the bus `issues.*` kinds answer `KIND_NOT_AVAILABLE` | Registry plus the pipeline that fills it | core | L | yes | HOLD |
| Structural tasks semantics | REAL_GAP | 1 | Mac: 7 tasks have no prompt (`AutoTask.swift:122-124`); they show an About text and run deterministic code (email/Slack ingest, issue creation, `/kb/outcomes/refresh`, fault sweep, graph report). Desktop: all 12 get an invented LLM prompt sent to `/kb/loop/agent-run` | A product decision, then real implementations or removal | core + decision | L | yes | HOLD |
| Restore-default confirmation | REAL_GAP | 3 | `NativeAutoTasksScreen.tsx:181` resets with no confirmation | A confirmation dialog: "Reset "X" template to default?", "Your custom prompt will be permanently replaced." | ui | S | no | yes |
| Effective prompt preview | REAL_GAP | 1 | Prompt assembled inline at :99-101 | Collapsible Show/Hide card with the exact text sent (prompt, skill, input, output, read-only wording) | ui | S | no | yes |
| Skill rescan | REAL_GAP | 1 | The desktop ↻ button (:174) reloads settings only; skills are scanned only when `projectRoot` changes (:38-43) | Button that calls `scanProjectSkills` again | ui | S | no | yes |
| Skill "(not installed)" marker | REAL_GAP | 1 | :177 keeps the row with no marker | Add the suffix to the label | ui | S | no | yes |
| Library folder picker | REAL_GAP | 3 | Desktop input and output are plain text fields (:175-176) | "Choose…" sheet listing folders under `source/ code/ data/ llm-doc/` (depth 4, max 400), with a filter, Clear and a loading state. Read-only, through `createHostFs().list` | ui | M | no | yes |
| Regression auto-reopen toggle | REAL_GAP | 1 | Desktop Loop reopens failed faults unconditionally (`NativeLoopScreen.tsx:486-491`) | Opt-out switch | ui | S | yes (writes fault files) | after decision T2 |
| Regression knobs (repair, timeout, header) | REWORDED | 3 | Loop stage editor :799, :812 | none | | | | |
| Schedule arm toggle | REWORDED | 1 | :192 | none | | | | |
| Empty states, recent runs, log header | REWORDED | 4 | :133, :154, :157, :186 | none | | | | |
| Push to iPhone | MAC_ONLY | 1 | desktop does not host `:3006` | | | | | |
| Run-history duration, cron placeholder | RUNTIME | 2 | host controls exist | | | | | |

Also found, but not in the inventory (the scanner missed it): the Mac schedule status line in `CronField` and `CustomTaskScheduleSection` ("Auto Tasks paused — master switch off", "Task disabled — won't run", "Scheduled · next <time>", "No upcoming fire"). None of these strings is anywhere in `ui/`. The desktop shows only "Scheduled · <description>" or "Schedule off" (:170).

## Implementation batches

**Batch A: pure UI, safe now** (only `ui/screens/autotasks/native/`; no writes outside localStorage):
1. Restore-default confirmation dialog (3 labels).
2. Effective prompt preview card (1). Pull the composition out of `runTask` into one function that both the preview and the run use.
3. Skill rescan button and the "(not installed)" marker (2).
4. Library folder picker sheet (3). Read-only folder listing through the host fs.
5. Schedule status line: master off, task disabled, next fire time. Next fire comes from `cron.ts` with a forward minute scan. Not an inventory label.

**Batch B: UI plus a small runner change; the core routes already exist**
1. The Model & Limits panel against `/kb/usage/limits|summary|ratelimits` (18 labels).
2. In the same change, make the desktop runner call `GET /kb/usage/resolve` before every Auto Task and Loop agent run. It must pass the chosen `model`, and pause with a notice when the chain is exhausted. Without this, the panel would promise caps the desktop does not apply. It reads and writes per-user limit rows only, so it is not on HOLD.

**Batch C: needs core, Rust or a product decision; all items are HOLD**
- **Custom tasks.** They run agents on a schedule, and Implement mode writes branches.
  - Recommendation: port Review mode first, manual Run only. Use desktop-local storage per project (the Mac keeps them in UserDefaults, so nothing is shared) and revert changes after the run, as `readOnlyOutput` does.
  - Add cron later, behind the same page scheduler.
  - Hold Implement mode until the desktop has a worktree/branch host command with the Loop's scope guard.
  - Decision already made: custom tasks are desktop-only; phone and extension refuse `custom.run`.
- **Template library.** Unattended prompts are written into the repo, behind a security approval gate.
  - Recommendation: port it only together with the approval gate. Store the approval hash on the host (prefs), never in localStorage the webview can rewrite.
  - Decision needed: should approvals be shared with the Mac app, or per app?
- **Claude subscription usage.** It reads another app's OAuth credential.
  - Recommendation: a Rust command that returns only the percentages, never the token. Ask the user first, because this means reading Claude Code's keychain item from a second app.
- **Structural tasks.** Highest-value finding, because the desktop behaviour is actively misleading, not just missing.
  - Decision needed (audit T1/T2 and the six-job-kind collapse): until the Node job kinds exist, either hide or disable the 7 structural tasks on the desktop, or label them "agent approximation".
  - Recommendation: disable them, with the Mac's About text, now. That is a UI-only change that removes behaviour rather than adding any.
- **Action-item pipeline.** Waits for the `issues.from_notes` / `issues.implement` job kinds.
- **Regression auto-reopen toggle.** Waits for decision T2 (regression merged into Loop).
- **Background scheduler.** Not a label: the desktop scheduler runs only while the Auto Tasks page is open (:194). It runs agents on a schedule, so it goes to the automation-kit Node job runner, not a UI timer.

## Not verified

- No GUI run on either app. Reachability comes from reading the call chains only.
- Whether `/kb/usage/limits` validation accepts every Mac value: field names were taken from `LlmIdeAPIClient+Usage.swift`, and the route bodies were not read in full.

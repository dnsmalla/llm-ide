# Loop parity triage (verified)

Input: the Mac Loop labels that `scripts/parity-inventory.mjs` could not find as text in the desktop Loop, Auto Tasks,
Settings, Shell, ui-kit or host code (`loop.md`). Three Haiku agents classified them first, in groups g01 to g03.
That is 137 rows, because a few labels have more than one Mac site. An Opus pass then checked each claim against the
code:

- every REAL_GAP (reachability on the Mac, absence on the desktop, what the host has today);
- every MAC_ONLY claim and the one DEAD_ON_MAC claim;
- all 46 REWORDED claims, by re-reading `NativeLoopScreen.tsx` in full against each cited line;
- all 8 RUNTIME claims.

The per-label result is in the scratchpad file `triage/loop-verified.json`. It uses the same schema, plus `id`,
`batch`, `verifiedBy` and `changed`.

## Counts

| Class | Haiku | Verified |
|---|---|---|
| REAL_GAP | 75 | 75 |
| REWORDED | 46 | 51 |
| MAC_ONLY | 7 | 2 |
| RUNTIME | 8 | 8 |
| DEAD_ON_MAC | 1 | 1 |
| Total | 137 | 137 |

- 10 labels changed class.
- 16 more REAL_GAP labels kept their class but had their needs, effort or risk corrected.
- The 75 REAL_GAP labels collapse into 28 features, plus Pause/Resume, which had no missing label.
- This round, Haiku's REAL_GAP total was about right: the overcalls and the undercalls cancel out (5 out, 5 in).
  The errors were in the details, not the total.

## First: bugs in what the desktop already ships

These are wrong behaviour today, not missing features. Fix them before any parity work.

1. **Scope globs are never enforced (confirmed).** The scope field saves `loop.scopeGlobs`
   (`ui/screens/loop/native/NativeLoopScreen.tsx:709`). But `guardProtected` (`:310-322`) checks only
   `protectedPaths(paths, extraProtectedGlobs)`, and nothing reads `scopeGlobs`.
   - On the Mac, every agent edit goes through `withScopeGuard` → `guardedEdit` → `checkScope` → `judge`. `judge`
     adds `outOfScopePaths(merged, scopeGlobs)` to the violations and applies the same policy
     (`mac/Sources/LlmIdeMac/Features/Loop/Services/LoopEngineRunner.swift:2494-2690`). That covers skill stages and
     every repair. Blank globs are ignored, an empty list means unrestricted, and policy Off skips both checks.
   - Desktop fix (UI only): in `guardProtected`, take the union of the protected hits and the changed paths that
     match none of the non-blank `scopeGlobs`. Off still skips both checks.
   - Safeguard needed in the same change. `loop_revert_paths` (`desktop/src-tauri/src/loop_runner.rs:325-348`) runs
     `git checkout -- <paths>`. That throws away uncommitted edits the user had in those files before the agent ran,
     and it fails on untracked new files. Scope enforcement would make it revert many more paths.
   - Before each agent call, snapshot `loop_changed_paths` (the host already has it). Revert only paths that were
     clean before the edit. For any other violation, stop the run and do not revert. The Mac does the same
     (`LoopEngineRunner.swift` handleViolation: pre-dirty paths are never reverted).
   - This snapshot also fixes the same latent data-loss risk in today's protected-path revert.
2. **Corrupt custom recipes are silently overwritten (confirmed).**
   - `loadCustomTemplates` returns `[]` when the stored JSON does not parse (`templates.ts:87-95`).
   - `saveCustomTemplate` then writes `[...[], t]` (`:107-111`), which replaces every stored recipe.
   - `deleteCustomTemplate` does the same.
   - Entries that fail the shape filter, and anything past 100 entries, are also dropped on the next save.
   - `persist` swallows write errors (`:97`), but the screen still says "Saved template".
   - The Mac keeps the bytes under `loopTemplateStore.undecodable`, refuses to save, and offers "Reset custom
     templates" (`LoopTemplateStore.swift:40-41, 77-111`; `LoopEngineView+DetailPane.swift:337-341`).
   - Fix (UI only): keep a raw backup key, refuse to save over undecodable data, make `persist` throw, show the
     error, and offer Reset (back up first).
   - The same `catch → []` pattern exists in `approvals.ts` and `queue.ts`. It is low risk there: it fails toward
     more approval prompts and an empty queue.
3. **The skill stage passes when the skill never ran (new finding).**
   - `/kb/loop/agent-run` returns `ran: false, reply: '', resultSubtype: null` when a requested skill is not in the
     user's library (`extension/llm_agent/sdk/loop-agent.mjs:526-533`).
   - The Loop skill stage treats `resultSubtype == null && typeof reply === "string"` as success
     (`NativeLoopScreen.tsx:366`), so an unresolved skill counts as a passed stage.
   - Auto Tasks already fixed this with `agentRunSucceeded` (`ui/screens/autotasks/native/model.ts:84`). Reuse it in
     Loop for both the skill stage and the repair (`:478`).
4. **The live log is lost after opening a past run (new finding).** `openRun` sets `selectedRun`, and nothing ever
   clears it (`NativeLoopScreen.tsx:162-165`, `838`). This is the Mac's missing "Back" button
   (`LoopEngineView.swift:1125`). Include it in the past-run fix.
5. **Desktop run records omit `changedPaths` and `summaryPath` (new finding).**
   - The record written at `NativeLoopScreen.tsx:501` has no `changedPaths` and no `summaryPath`, even though both
     are computed at `:483` and `:494`.
   - So the past-run "Changed:" line (`:827`) and "Open summary note" (`:828`) appear only for records the Mac wrote.
   - Fix: write both fields. This is also the prerequisite for any run-changes review.
6. **Stale comment.** `regression.ts:3` says the semantic judge is not ported, but `NativeLoopScreen.tsx:343-350`
   implements it. Correct the comment. It misled the Haiku pass.

**Pause/Resume during a run (confirmed missing).**
- The Mac toolbar shows Pause/Resume while running (`LoopEngineView.swift:679-685`, `pauseRun`/`resumeRun` at
  `:1880-1890`). It holds at the next stage boundary (`LoopEngineRunner.swift:479-500, 1014-1020`).
- A pause has a timeout (`pauseTimeoutSeconds`), because a forgotten pause holds the repo lock. Paused time does not
  count toward the time budget.
- The desktop has only Stop (`NativeLoopScreen.tsx:702`). Its pause-timeout field is disabled and labelled
  "not enforced" (`:726`).
- Port it as UI only:
  - give `runNativeLoop` a `waitWhilePaused` dependency, checked where `isCancelled` is (`runner.ts:43,50`);
  - add the pause timeout in the same change, because a paused desktop run blocks `queueRef` and the scheduled tick
    (`:546`);
  - leave paused time out of `expired()`.

**Refactor batches.** The refusal (`store.ts:62-75`, `NativeLoopScreen.tsx:588`) is correct and stays. The Mac's
batches depend on `RefactorBatchRollback`, which needs a host snapshot and restore. Batch C.

**Bulk approve.** Confirmed: the desktop asks once per command, at run time (`NativeLoopScreen.tsx:426-435`).
Approvals are machine-held (`localStorage`, keyed by work root plus the exact command, `approvals.ts:14`) and never
come from `loop.json`. On HOLD, see below.

## Reclassifications

| Label (id) | Haiku → Verified | Why |
|---|---|---|
| "Not run by the scheduled Loop auto task" (g01.10) | REAL_GAP → REWORDED | The desktop shows the same flag the other way round: ◷ "Runs on schedule" (`NativeLoopScreen.tsx:662`) and the "Scheduled" overview row (`:719`). |
| "Budgets — a run stops at whichever…" (g01.28) | REAL_GAP → REWORDED | The budgets are present (`runner.ts:39-51`) and the "Bounded by" line (`:718`) explains them. Made consistent with g03.35, which Haiku already called REWORDED. |
| "If a repair edits a test, build file, or system/" (g01.32) | REAL_GAP → REWORDED | Lead-in of the same policy picker, which has the same four options (`:731`). |
| Summary-note explanation (g01.40) | REAL_GAP → REWORDED | Toggle at `:733`, note written by `summary.ts`. The journal is always written. |
| "Re-runs the Regression sweep … with repair" (g02.40) | REAL_GAP → REWORDED | The judge is on the desktop (`:343-350`). A failed sweep is repaired by the generic repair (`runner.ts:64-76`) and failed faults are reopened (`:486-492`). Haiku trusted the stale `regression.ts:3` comment. |
| "Applying replaces the current stages and budgets…" (g01.22) | MAC_ONLY → REAL_GAP | Only the approvals sentence is Mac-only. The desktop Apply (`:769-777`) also replaces stages and budgets, with no warning. Copy only. |
| "Open a project with a cloned repo to approve or run shell…" (g02.33) | MAC_ONLY → REAL_GAP (C) | The Mac requires a git checkout, because its guard needs git. The desktop runs in `work_root`, which falls back to a non-git folder (`loop_runner.rs:81-90`); there, revert and changed-paths cannot work. This is a product decision, not a by-design difference. |
| Worktree captions "This run worked in a different checkout…", "elsewhere" (g03.16, g03.21) | MAC_ONLY → REAL_GAP (C) | Worktrees are a known not-ported feature (`:736-741`), not a deliberate omission. Folded into worktrees. |
| "Self-Heal incident triage…" (g03.41) | MAC_ONLY → REAL_GAP (C) | Listed as known not ported (`:741`, master plan S2). The stage is refused at `:447`. Needs a core incident store. |

Kept after checking:

- **MAC_ONLY**
  - "Stop the run started from" (g02.20): phone and Auto Task lane runs, which the desktop has no source for. Its own
    scheduled runs use the same Stop.
  - "SDK Adoption diff…" (g03.42): a dev-only stage for LLM-IDE's own checkout, tied to the Mac SDK adoption ledger in
    `Core/Incidents`.
- **DEAD_ON_MAC**
  - "This runner was already busy" (g02.23). The Mac's own comment says "Defensive only"
    (`LoopEngineView.swift:730-733`). Confidence is medium: a lane run might still reach `didRejectLastRun`.
  - Either way, the desktop needs nothing here: it queues instead of rejecting (`:515-525`).
- **RUNTIME**: all 8 are placeholders or empty-state decoration with no behaviour (example goal, criteria, glob and
  command texts; "Choose a recipe…"; "Not inspected yet."; "Enter a command for this stage.", where the desktop
  disables Run stage instead, `:683`).
- **REWORDED**: all 46 were re-opened against `NativeLoopScreen.tsx` (100%, all three groups). The other 41 are
  correct. Two notes on matches that are close but not exact:
  - The Mac stage timeout is set in minutes, the desktop field in seconds (`:812`).
  - A failed skill stage ends the Mac run (`LoopEngineRunner.swift:2160-2180`), but on the desktop it goes to the
    repair step.

## Merged feature table

The Batch column gives a placement for every feature, so it also says whether the item is safe to do now.

| Feature | Final class | Labels | Evidence | What is missing | Needs | Effort | Risky | Batch |
|---|---|---|---|---|---|---|---|---|
| scope-enforcement | REAL_GAP (bug) | 3 | `NativeLoopScreen.tsx:310-322` ignores `scopeGlobs`; Mac `LoopEngineRunner.swift:2660-2690` | Out-of-scope check under the policy, plus a pre-edit dirty snapshot so revert never discards user edits | ui | S | yes (revert) | A1, first |
| recipe-store-errors | REAL_GAP (bug) | 2 | `templates.ts:92-110` overwrites unparsable data | Refuse to overwrite, backup key, error message, Reset | ui | S | no | A1, first |
| pause-resume | REAL_GAP (no label) | 0 | Mac `LoopEngineView.swift:679-685`; desktop Stop only | Hold between stages, enforced pause timeout, paused time outside the budget | ui | S-M | no | A1, first |
| skill-stage false pass | bug (no label) | 0 | `NativeLoopScreen.tsx:366` versus `loop-agent.mjs:526-533` | Use `agentRunSucceeded` | ui | S | no | A1, first |
| past-run-inspector | REAL_GAP | 5 | `selectedRun` never cleared (`:163`); blank on a null record | Back, "could not load", Reveal JSON (`reveal_in_os`), budgets snapshot from `record.config`, "No stages executed", plus writing `changedPaths`/`summaryPath` into records | ui | S | no | A1 |
| approval-state-indicator | REAL_GAP | 2 | `isApproved` exists (`approvals.ts:18`) | Read-only mark on unapproved shell stages and a pre-run notice. Grants nothing. | ui | S | no | A1 |
| leave-queue | REAL_GAP | 1 | Only Clear queue (`:568-572`) | Remove the selected loop's queued run | ui | S | no | A1 |
| loop-list-builtin-lock | REAL_GAP | 1 | No marker on rows (`:662`) | Lock icon and tooltip | ui | S | no | A1 |
| template-picker-groups | REAL_GAP | 2 | Flat selects (`:645-649, 765-767`) | optgroup Built-in / My templates | ui | S | no | A1 |
| recipe-summary | REAL_GAP | 1 | `saveCustomTemplate(name, "")` (`:783`) | Ask for a description | ui | S | no | A1 |
| template-apply-warning | REAL_GAP | 1 | Apply replaces the config silently (`:769-777`) | Warning copy (stages and budgets replaced until Save) | ui | S | no | A1 |
| protected-off-warning | REAL_GAP | 1 | "Do not check" has no warning (`:731`) | Warning that a repair can delete the failing test | ui | S | no | A1 |
| output-reveal | REAL_GAP | 2 | No Output rows; host `reveal_in_os` exists (`os_open.rs:348`) | Journal, faults, working tree and summary rows with Reveal / not yet | ui | S | no | A1 |
| non-improving-scoring | REAL_GAP | 2 | `runner.ts:80-85` compares only the output text | Failing-count score (via `parseTestResults`), recorded per attempt and shown in the inspector | ui | M | no | A2 |
| artifact-check-feedback | REAL_GAP | 1 | Mac `artifactCheckFeedback` (`LoopEngineRunner.swift:248-250, 2142`) | Feed the failed check's findings into the next skill prompt | ui | S | no | A2 |
| default-stage-upkeep | REAL_GAP | 4 | Revisions are in `defaults.ts`, never compared | Update banner, Reset to default (keeps enabled, severity, timeout), disabled-by-detection caption and re-enable | ui | M | no | A2 |
| command-suggestions | REAL_GAP | 3 | One "Use detected:" button (`:803`) | Ranked Makefile/package-script menu, with More targets | ui | M | no | A2 |
| run-log-filter | REAL_GAP | 4 | Plain untagged log (`:838`) | Text filter (S); warn/error toggle needs a level per line (M) | ui | M | no | A2 |
| skill-library-picker | REAL_GAP | 1 | Free-text skill id (`:805`); `/kb/agent/skill-library` exists | Picker from the skill library. Keep manual-only and batch rules, checked at run time. | ui | S | no | A2 |
| loop-defaults-card | REAL_GAP | 5 | Settings "loop-defaults" is Planned (`settings/notices.ts:28`) | App-wide defaults for budgets, policy, shell/agent timeouts and template count, used by new projects and by stages with no timeout | ui + storage choice | M | no | B |
| run-changes-review | REAL_GAP | 15 | `git_diff_hunks` is index-vs-worktree only and on the Explorer root; `git_scm::commit` (`:493`) commits the whole index | Read-only: a host HEAD diff and status per path in `loop_work_root` (B). Commit: pathspec commit of the run's paths only (HOLD). | rust | L | yes | B + HOLD |
| bulk-approve | REAL_GAP | 4 | Per-command confirm (`:426-435`) | One confirm listing every exact command | ui | S | yes (approvals) | HOLD |
| python-env-check | REAL_GAP | 2 | `loop_environment_check` only runs the PATH `--version` (`loop_runner.rs:387-398`) | Run the project interpreter: `python -m pytest --version`, `pip check` | rust | S | yes (runs a repo binary) | HOLD |
| python-env-setup | REAL_GAP | 3 | No host path | Create `.venv` and install dependencies + pytest after a listed-commands confirm | rust | M | yes | HOLD |
| worktrees | REAL_GAP | 4 | Disabled checkboxes (`:736-737`) | Worktree create, retain and cleanup; concurrent runs | rust | L | yes | C |
| merge-request | REAL_GAP | 1 | Disabled (`:735`) | Branch, commit, push and MR after a clean run | core + rust | L | yes | C |
| refactor-batches | REAL_GAP | 2 | Correctly refused (`store.ts:68-75`) | Batch rollback snapshot and restore in the host | rust | L | yes | C |
| incident-triage | REAL_GAP | 1 | Refused (`:447`) | Core incident store or route | core | L | yes | C |
| git-root-gate | REAL_GAP | 1 | `work_root` falls back to a non-git folder (`loop_runner.rs:81-90`) | Decide whether shell stages and repairs require git; the host must report whether the work root is a repo | rust (small) + decision | S | yes | C |
| autosave | REAL_GAP | 1 | Desktop uses explicit hash-guarded Save (`store.ts:41-44`) | Mac autosave. Recommendation: do NOT port; explicit Save protects a `loop.json` shared with the Mac and git. | ui | M | no | C (decision: won't do) |

## Implementation batches

**Batch A1: small, pure UI, safe. Do first, in this order.**

1. scope-enforcement, with the pre-edit dirty snapshot (revert only paths that were clean before; otherwise stop).
2. recipe-store-errors.
3. Pause/Resume, with the pause timeout enforced. Enable the existing field, `:726`.
4. skill-stage false pass (`agentRunSucceeded`).
5. past-run-inspector, including Back and writing `changedPaths`/`summaryPath` into records.
6. approval-state-indicator (read-only).
7. leave-queue.
8. output-reveal.
9. protected-off-warning.
10. template-apply-warning.
11. recipe-summary.
12. template-picker-groups.
13. loop-list-builtin-lock.
14. The `regression.ts:3` comment.

**Batch A2: pure UI, medium.** non-improving-scoring, artifact-check-feedback, default-stage-upkeep,
command-suggestions, run-log-filter, skill-library-picker.

**Batch B: UI plus a small host or storage change.**

- loop-defaults-card. Choose `localStorage` (as the custom recipes do) or typed `prefs.rs` fields.
- The read-only half of run-changes-review. It needs a host `git diff HEAD -- <path>` and a status per path, rooted at
  `loop_work_root`. Today the git commands run against the Explorer root.

**Batch C: Rust, core or a product decision.**

- worktrees;
- merge-request (core shipping and repo permissions);
- refactor-batches (host rollback);
- incident-triage (core incident store);
- git-root-gate (decide: require git for shell stages and repairs, or keep the plain-folder fallback);
- autosave (decide: recommend won't do);
- Windows shell stages. `run_command_with` always starts `/bin/sh -lc` (`loop_runner.rs:186`). The boundary probe
  calls `bash` (`:375`) and the guard calls `git` from PATH. Shell stages cannot start on Windows. Decide between Git
  for Windows `sh`, `cmd /C`, or a refusal with a clear message; today the error is only "cannot start the stage
  command".

## HOLD (commands, commits, environments, approvals)

- **bulk-approve.** Acceptable with safeguards:
  - one confirm that lists every exact command and the work root;
  - the key stays root plus exact command, in machine storage only;
  - never offered or taken for scheduled runs (`ensureApprovals(target, false)` keeps refusing);
  - never derived from any flag in `loop.json`;
  - any change to a command's text needs a new approval;
  - ship the read-only indicator (A1) first.
- **python-env-check.** Acceptable with safeguards:
  - only on an explicit click;
  - fixed argv, no shell;
  - the interpreter resolved only from `.venv/` or `venv/` inside `loop_work_root`, and its absolute path shown
    before it runs: a cloned repo can ship its own `.venv/bin/python`;
  - a timeout;
  - output shown verbatim;
  - nothing installed.
- **python-env-setup.** Keep on hold until there is a product decision. If approved:
  - a host-built plan, never a page-supplied command;
  - a confirm that lists every command;
  - never run unattended;
  - install only into a project `.venv`;
  - a log of each step;
  - no `sudo` or global pip.
- **run-changes-review commit.** Needs a host pathspec commit:
  - `git commit -- <paths>`, with paths validated as repo-relative and limited to the run's recorded `changedPaths`;
  - the same no-hooks and no-signing options as `git_scm::commit`;
  - a warning for partly staged files;
  - an explicit click.
  Never push.
- **merge-request, worktrees.** Batch C. Both push or create branches, so they stay held until the shipping design
  (permissions per repo, clean-start rule, secret scan) is ported.

## Could not verify

- Whether "This runner was already busy" is fully unreachable on the Mac. A lane (phone or schedule) run on the same
  key might still set `didRejectLastRun`. The decision does not change: the desktop needs nothing.
- Whether the Mac's failing-count score applies to every runner, or only to parseable ones. The copy says it falls
  back to unchanged output. Not run.
- No code was run. Every finding comes from reading the code.
